# Re-running the writer without touching prospects

`scripts/export-writer-run.ts`

## What this does

It runs the writer, the floor and the judge over prospects that have already been
researched, and it writes nothing to the database. It exists so the same prospects can be
measured twice, before and after a change, without the first measurement destroying the
thing the second one would be compared against.

Run it like this:

```
npx tsx --env-file=.env.local scripts/export-writer-run.ts --with-question
npx tsx --env-file=.env.local scripts/export-writer-run.ts <prospect_id> [<prospect_id> ...]
```

`--with-question` selects every prospect currently holding a `personalisation_question`,
which is the set holding shipped copy.

Output lands in `.writer-export/`, which is gitignored. Two files per run, sharing a
timestamp: a JSON file with everything, and a text file laid out for reading, with the
stored copy above this run's copy for each prospect.

## Why it exists

The obvious tool for this is `run-research.ts --allow-overwrite-trigger`, and it cannot be
used. That path REPLACES `personalisation_trigger`, `personalisation_question` and
`personalisation_subject` when the judge picks the written version, and CLEARS all three
when the judge holds. The prospects worth measuring are exactly the ones already holding
copy, so measuring them that way overwrites the baseline. Run it twice and the second run
has nothing to compare against, and the copy that was there is gone.

So this reproduces the paid half of a stored-findings run and stops one line before the
two writes.

## Why it cannot write

Two independent mechanisms, because there are two different failure modes.

**The paid path has no database client.** `produceOpening` takes no `SupabaseClient`
parameter, and neither does anything it calls. `write-opening.ts` constructs an Anthropic
client and nothing else. There is no connection in scope for the writer, the floor or the
judge to write through. That is a stronger statement than withholding permission from a
client, because there is no client to withhold anything from.

The writes are in the caller, not in `produceOpening`. `storeResearchResult` and
`updateProspect` in `prospect-research-agent-v2.ts` do them, and `updateProspect` is the
only write site in the codebase for the three personalisation columns. This script is a
second caller that stops earlier.

**The script's own reads go through a client that cannot express a write.** It still has
to read the prospect, the stored findings, the messaging document and the organisation
name, so it needs a client for those. `readOnlyClient` wraps a service-role client in a
Proxy with an allowlist of read methods. `insert`, `update`, `upsert`, `delete` and `rpc`
are not on it, and neither is anything else, so an unlisted method throws.

The allowlist direction is the point, not a detail. A denylist of write verbs passes
through anything it was not told about, which is the same shape as a test fake that
silently accepts a call it does not implement and reports success. This one fails closed.

`rpc` is refused alongside the write verbs because a `SECURITY DEFINER` function is a write
path that does not look like one.

The allowlist also catches the hazard that actually matters here, which is not someone
writing a stray `insert` in this file. It is calling a production helper that writes as a
side effect. `loadProspectContext` stamps `prospects.segment_id` when it finds it null.
This script does not call it, and reads the prospect with a plain select instead; if it
ever did call it, the proxy would turn a silent write into an immediate throw.

**The gap, stated rather than glossed.** `loadClientContext` builds its own service-role
client internally, so the proxy does not cover it. It was read instead: three selects
across `segments`, `organisations` and `strategy_documents`, and no write. That is an
inspection, which is weaker than a structural guarantee. This is why the check that
actually settles the question is empirical, below.

## How the no-write claim is verified

Not by reading the code. By fingerprinting the rows before and after:

```sql
select md5(string_agg(
         p.id || '|' ||
         coalesce(p.personalisation_trigger,'<NULL>')  || '|' ||
         coalesce(p.personalisation_question,'<NULL>') || '|' ||
         coalesce(p.personalisation_subject,'<NULL>')  || '|' ||
         coalesce(p.research_ran_at::text,'<NULL>')    || '|' ||
         coalesce(p.trigger_data::text,'<NULL>')       || '|' ||
         coalesce(p.current_research_result_id::text,'<NULL>')
       , E'\n' order by p.id))
from prospects p
where p.personalisation_question is not null;
```

It covers more than the three columns on purpose. `research_ran_at`, `trigger_data` and
`current_research_result_id` are the other things `updateProspect` sets, so a write that
somehow spared the copy would still move the fingerprint.

Three more counts are worth taking alongside it, because they catch writes to other
tables that the fingerprint cannot see:

| check | why |
|---|---|
| `count(*) from agent_runs` | `startAgentRun` inserts a row. This script never calls it. |
| `count(*) from prospect_research_results` | `storeResearchResult` inserts a row. |
| `count(*) from prospects where segment_id is null` | This can only go DOWN, and only if something called `loadProspectContext` and stamped a segment. |

## Pinning the messaging document

`--messaging-doc-id=<uuid>` brief the writer with a named document instead of resolving it
by the production rule.

The default is the production rule: the document that is both `active` and
`client_approval_status = 'approved'`, via `fetchApprovedMessagingDoc`.

The override exists because a baseline usually needs a document that has since been
archived, and because the brief is half of what the writer produces. Running a baseline
against one document and a later comparison against another moves two things at once, and
no difference in the output can afterwards be attributed to either. It is the same reason
the judge holds the subject line constant across both sides of its comparison.

The document id and version are recorded per prospect in both output files. Before reading
anything into a difference between two runs, check they used the same document.

A pinned id is operator input, so it is verified to belong to the requesting organisation
and to be a messaging document before its content is used.

## Reading the gate numbers

`OpeningResult.gate_failures` cannot be counted, and a histogram built from it is
misleading rather than merely incomplete.

That field carries the failures of the FINAL attempt, and only when that attempt was the
one that gated. A prospect gated on the first attempt and rescued on the second leaves
nothing in it. A prospect whose final attempt lost on the judge reports an empty array
however many gates it tripped getting there. So counting that field produces a count of
prospects whose last attempt happened to be gated, which is a different quantity with a
similar-sounding name.

`writeAndJudgeOpening` therefore takes an optional `onAttempt` callback that reports every
attempt as it finishes. It is pure telemetry, defaulted off, and both production callers
omit it, so production behaviour is unchanged. The script counts gates from that.

Gate failures are free-text sentences written for a model to act on, so classifying them
by gate means matching their prose. An unrecognised failure is counted under
`unclassified` and printed in full, never dropped and never folded into a neighbouring
bucket. The input that classifier will eventually meet is a gate added after it was
written, and silently absorbing that one is how the count would go quietly wrong.

## What the cost figure is and is not

It is derived from the token usage the Anthropic API returned for each call, priced at
Sonnet 4.6 rates with the standard cache multipliers: a 5-minute cache write at 1.25x
input, a cache read at 0.1x input.

It is not an invoice. Per the standing rule, the Anthropic console is the ground truth for
cost, and any figure from here is checked against a console day filtered to the run before
it is quoted to anyone.

Two things bias it downward and both matter when reading it:

- The script runs **serially**, which gives the prompt cache the best hit rate available.
  A concurrent production batch pays extra cache writes at the head of the fan-out.
- A second run over the same prospects reuses a warm cache. The measured per-prospect cost
  on a cold cache is several times the warm figure, so a run that follows another run
  understates the standalone cost substantially.

## When it breaks

**"no active + approved Messaging document found"** means exactly what it says, and it
means research and compose are broken for that organisation too, not just this script.
Check the documents directly:

```sql
select id, status, client_approval_status, version, created_at
from strategy_documents
where organisation_id = '<org>' and document_type = 'messaging'
order by created_at desc;
```

A newly generated document is `active` but `pending`, and generating it archives the
previously approved one, so there is a window where nothing satisfies both conditions.

**"was called on the read-only client"** means the script reached for a method that is not
on the read allowlist. Do not widen the allowlist to make the error go away. Find out what
called it: the usual cause is a production helper that writes as a side effect, which is
the case the proxy exists to catch.

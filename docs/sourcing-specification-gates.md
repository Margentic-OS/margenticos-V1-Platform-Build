# sourcing-specification-gates.md
# The two checks that ask whether sourcing is returning what the client asked for.
# Built 2026-08-27. Neither fixes anything. Both make an existing silence audible.

## What problem these solve

The Apollo search query is hardcoded (see adapter-apollo.ts, and ADR-032). Every client
sourced through that handler gets the same NAICS 5416 consulting filter, whatever their ICP
says. That is a conscious trade-off while MargenticOS runs as client zero, and it is not
what these gates change.

What they change is that the trade-off used to be **invisible at run time**. A client whose
ICP named schools would have been handed management consultancies with no error, no warning,
and a run recorded in `agent_runs` as `completed`. The orchestrator's manifest check (step 4)
did not catch it, because it asks whether the handler SUPPORTS a filter field, not whether
the query it actually sends has anything to do with what the client asked for.

## The two gates, and why there are two

They answer different questions and neither substitutes for the other.

| | Pre-search gate | Returned-industry assertion |
|---|---|---|
| Where | `orchestrator.ts`, step 4.5 | `tiering-trigger.ts`, step 6.5 |
| When | Before the handler is called | After enrichment, during tiering |
| Asks | Does the query ASK FOR anything this ICP wants? | Did the rows that CAME BACK match? |
| Reads | `spec.industries` vs `handler.targeted_industries` | `prospects.company_industry` mapped to canonical, vs `spec.industries` |
| Cost when it fires | None. Apollo is never called. | Enrichment has already been paid for. |

**Why the pre-search one is not enough.** It proves what we asked for, not what arrived.
Apollo silently ignores a parameter it does not recognise, so a filter that reads correctly
and passes this gate can still return an unfiltered result: a parameter that stopped being
honoured looks exactly like one that never existed. That failure is only visible in the rows.

**Why the post-enrichment one cannot move earlier.** Sourcing candidates carry no industry.
Apollo's free `mixed_people/api_search` response carries `has_industry` as a boolean and
never the value (verified against the live API 2026-08-23, see BACKLOG), and the orchestrator
writes `company_industry` as NULL with a comment saying enrichment will fill it. The value
first exists after `people/match` at enrichment time. There is nothing to check before that.

## What each one does when it fires

**Pre-search gate.** Throws. `runSourcing` never throws to its caller, so the refusal comes
back as `result.error` and is written to `agent_runs` as `failed`. The message names the
industries the ICP asked for, the industries the handler targets, and the fact that the query
is hardcoded so editing the ICP will not fix it.

It does NOT fire on partial coverage: if even one spec industry is targeted, the run
proceeds, and the unreachable ones are logged at `warn` by name. It does NOT fire when
`spec.industries` is empty, because an empty list is the spec declining to constrain industry
rather than disagreeing with the query. That case logs a `warn` too.

**Returned-industry assertion.** Throws after the prospects have been written with their
tiers, so there is no partial state: the rows keep their `sourced_tier` and `tiering_reason`,
and the run is marked failed with a message naming what the ICP asked for and what the batch
actually came back as, counted by industry.

There is deliberately **no minimum batch size**. A batch of one off-specification prospect
fails the run. A threshold would be a number nobody has measured, and a check that stays
quiet below an invented floor is the shape this work exists to remove.

## Where the handler's targeting is declared

`APOLLO_TARGETED_INDUSTRIES` in `adapter-apollo.ts`, exported, and copied onto the handler
object as `targeted_industries`. The orchestrator READS it rather than keeping a second copy:
two lists that must be kept in step by hand is the parallel-array shape CLAUDE.md warns about.

It is typed `readonly CanonicalIndustry[]`, so a name outside the canonical taxonomy is a
compile error rather than a silently empty intersection at run time.

`SourcingHandler.targeted_industries` is REQUIRED, not optional. Optional would let a new
handler skip the gate by omission, which is the silent default this field exists to close.

## What to check if it breaks

- **Sourcing suddenly refuses for a client that used to work.** Compare the two lists in the
  error message. Either the ICP gained an industry outside NAICS 5416, or `APOLLO_FILTER`
  changed and `APOLLO_TARGETED_INDUSTRIES` was not updated with it. They live in the same
  file, next to each other, for exactly this reason.
- **Tiering suddenly fails with "nothing on specification".** Read `returned_industries` in
  the error log line. If it is full of `(unmapped) <tag>` entries, the problem is
  `APOLLO_TO_SPEC` in `industry-mapping.ts` not knowing a tag, not the sourcing query. If it
  is full of genuinely off-target industries, a search parameter has stopped being honoured.
- **Neither ever fires and you expect one to.** Both gates skip when `spec.industries` is
  empty. Check the stored `icp_filter_spec` first.

## A removal is a frozen verdict

`tierEnrichedBatch` skips any prospect that already carries a `tiering_reason`, so a
removed prospect is never re-examined by the normal path. That is what stops decided rows
eating the batch cap, and it means the removal reasons counted on the review screen are
STABLE between runs rather than rewritten every time.

Removals are put back in the queue when a new ICP filter spec is stored for the
organisation, and by nothing else. See ADR-037, which also lists the three removal reasons
that still have no re-evaluation path at all.

## When the spec itself cannot be built, added 2026-09-11

Everything above assumes a spec exists. `deriveFilterSpec` refuses to build one at all when
the ICP cannot support a search, and that refusal used to be the quietest failure in this
area.

**What refuses.** Each refusal throws `FilterSpecRefusal` naming its rule:
`non_canonical_industry`, `no_seniority_bands`, `no_geography`, `no_headcount_bound`,
`headcount_inverted`. `persistIcpFilterSpec` adds three causes of its own:
`geography_unresolved`, `buyer_criterion_failed` (seniority comes off that call, so its
failure empties seniority, and the cause is named rather than the rule it trips), and
`spec_write_failed`.

**Why it was silent.** Every path that promotes an ICP (approve, auto-approve, revise,
revert) builds the spec AFTER the version is live and the request has reported success. A
refusal left `icp_filter_spec` NULL, the page said the change worked, and the only record was
Sentry, labelled "non-canonical industries" whatever had actually refused. On 2026-09-08
three versions of one live client's ICP in a row went live with no spec, all for a headcount
with no usable numbers.

**What happens now.** The refusal is written to `strategy_documents.icp_filter_spec_refusal`
and the ICP strategy page shows the operator "Sourcing cannot use this version" with the
reason and the refusal's own text. A version with neither a spec nor a refusal shows "Search
specification not built yet", because straight after a change the build is still running,
and if it lasts the build never ran. Neither state is shown to the client.

**What it does not do.** It needs someone to open the page. Nothing yet alerts on an active
ICP with no spec; that monitor is its own Backlog row.

## The third check, added 2026-08-28: the spec inspector

`inspectFilterSpec` in `src/lib/sourcing/inspect-filter-spec.ts`. Report only, never gates.
It runs twice: on the spec being PROPOSED (`proposeIcpFilterSpec`, since ADR-061) and on the spec being READ
(`orchestrator.ts`, step 2.5). Two silences meet here.

**Frozen specs.** `deriveFilterSpec` has exactly one caller and it runs only when a document
is promoted. Nothing recomputes a spec on read. So changing the derivation leaves every
existing row on the old shape, and production carries a mixed population. Every reader casts
`icp_filter_spec as ICPFilterSpec` with no runtime check, and the two places that matter
(`tier-classification.ts`, industries and industries_excluded) guard with `&&`. An absent
field therefore degrades to NO SCORING and NO EXCLUSION rather than to an error: the rule
silently stops being applied while the pipeline keeps reporting success. Same family as the
opt-out footer that was validated and then discarded.

**Industries that are targeted and unclassifiable at the same time.** `APOLLO_TO_SPEC` is
inbound-only and many-to-one, so its RANGE is smaller than the set of names the handler
declares it targets. Four canonical names sit in that gap today:

    Environmental Consulting
    Engineering Consulting
    Healthcare Consulting
    Executive Coaching

Each passes the pre-search gate above and can then never be produced by the classifier, so
every prospect for it is removed as `industry_not_consulting` with nothing saying why. Three
of the four are in MargenticOS's live stored spec. `CLASSIFIABLE_INDUSTRIES` in
`industry-mapping.ts` is the range; the test in
`src/lib/sourcing/__tests__/inspect-filter-spec.test.ts` enumerates the four so a FIFTH
fails the build.

It reports rather than gates on purpose: promoting it would newly refuse runs, which is a
decision, not a cleanup. Logged in BACKLOG.

**Limit, so it is not over-trusted.** The classifiable range is the STATIC map only.
Operators can add `industry_tag_mappings` rows, which can only ADD names. So a flagged name
may be classifiable in practice, which is why callers may pass extra known names and why
this reports rather than fails.

## One list of filter fields, not three

Until 2026-08-28 there were three, and they disagreed: `ICPFilterSpec`'s own keys,
`FILTER_FIELDS` in `sourcing/types.ts` (19 names, 8 of which no spec has ever had), and
`SUPPORTED_FIELDS` in `adapter-apollo.ts` (which claimed two fields the type lacks).

The manifest check iterates `FILTER_FIELDS`, so **a field added to `ICPFilterSpec` and not
to that list was never checked** — the adapter could discard it with no divergence reported.
The parallel-array shape from CLAUDE.md, three lists deep.

`FILTER_SPEC_FIELDS` and `FILTER_SPEC_METADATA_FIELDS` in `icp-filter-spec.ts` are now the
single source; the other two derive from it. Two compile-time assertions beside them fail if
either list drifts from `keyof ICPFilterSpec`, in either direction. Both directions are
checked because only checking the one you expect to break is how the original three drifted.

The FILTER/METADATA split is load-bearing: metadata fields (`notes`,
`unmatched_industries`) constrain nothing, so including them would make the manifest check
demand every handler "support" `notes` and throw for every client.

## Proving a filter actually filters

`scripts/apollo-prove-filter.ts`. Four assertions per mapping, not one, because a count that
moved is not proof. See `docs/discovery/2026-08-28-apollo-filter-silent-ignore.md` for the
measurements behind it, including the province that silently widens to its country.

Run it before shipping any canonical-to-Apollo mapping. It costs no Apollo credits.

## Where the headcount range comes from (changed 2026-09-20)

`company_headcount_max` is a hard ceiling: `resolveHeadcountCeiling` removes every prospect
above it. There are now TWO possible sources for the pair and exactly one of them runs on any
given derivation.

**If the client answered the intake headcount question**, the two whole numbers they typed
are used and `company_profile.headcount` is not parsed at all. Not parsed and overridden, and
not parsed and compared: a parse that runs and is discarded becomes a second value that a
later edit can start believing.

**If they have not**, `parseHeadcountRange` reads the tier prose exactly as before, and
refuses the derivation if neither tier establishes a bound.

The spec's `notes` say which one ran, in one sentence, so an operator reading a surprising
ceiling does not have to read the code to find out.

**Why this changed.** The parser is a reasonable reader of prose and is not the problem. The
problem was that a parser was the ONLY reader of a field nobody had been asked about, so a
sentence stating no range still produced one. Measured 2026-09-20: a tier reading "anywhere
from a two-person firm to a 600-person company" parses to 600 to 600, throws nothing, passes
every guard, and targets companies of exactly that size. That case is now a test in
`src/lib/agents/__tests__/stated-headcount-beats-the-parser.test.ts`, asserted rather than
described, so the reason for the change stays visible.

**A malformed stated pair falls back to the document rather than failing.** A failed spec
derivation stops sourcing for that client until a human re-approves; losing one binding does
not.

## Which edits count as targeting (added 2026-09-30, ADR-061 step 2)

**What this does.** It answers one question about any edit to a client's ICP: did it change
who we would source, or only the words? `src/lib/sourcing/targeting-inputs.ts` holds the list
of targeting fields. For tier 1 and tier 2 they are the company profile's industries,
headcount, revenue range and geography, the buyer's title and seniority, and the
disqualifiers. Two more sit outside the document: the headcount pair a client typed into
intake, and the organisation's revenue-filter switch. Everything else is prose. Triggers and
their reasons, the summary, the job-to-be-done statement, labels and descriptions are never
targeting fields.

**Why it exists.** On 2026-09-30 an edit to two trigger reasons rebuilt one client's search
and removed 62 prospects, because nothing in the system knew that edit was only words.

**What it connects to, since step 4 (2026-09-30).** `proposeIcpFilterSpec` in
`src/lib/sourcing/propose-icp-filter-spec.ts` runs after every ICP promotion (approve,
revise, restore) and when the intake headcount or the revenue switch is saved. It compares
the current targeting fields with the ones stored inside the live settings.

- **Same:** nothing happens. No model is called and nothing is written. The search, the
  sourcing cursor and every tiering verdict stay as they were.
- **Different:** it builds a proposal and stores it in `icp_filter_spec_proposed`, beside
  the live settings, which it does not touch. Only the parts whose inputs changed are
  rebuilt. A headcount edit calls no model for the buyer or the geography.

**Approving or rejecting a proposal, since step 5 (2026-10-01).** Operator-only, through
two routes: `POST /api/operator/icp-filter-spec/approve` and `.../reject`. Both are thin
gates over `src/lib/sourcing/approve-icp-filter-spec.ts`. The operator presses them from
the before-and-after panel on the client's ICP page (step 6, 2026-10-01). See
`docs/dashboard.md`, "Proposed change to the search".

An approval is refused, and nothing is written, when:

- the proposal or the live settings changed after the operator's page was loaded
- the proposed buyer criterion would not gate. A criterion that does not gate never
  becomes live
- the proposal stops applying an exclusion that is live, and that removal was not ticked.
  Each removed exclusion is named and needs its own tick. Switching an exclusion axis off
  counts as removing every entry on it
- it would move the client's place in the search while a sourcing run is in progress

An approval that goes through does up to four things in ONE database transaction
(`approve_icp_filter_spec_proposal`):

1. The proposal becomes the live settings and the proposal is cleared.
2. Who approved it, and when, are recorded.
3. The sourcing cursor is reset to zero ONLY if the request the sourcing handler builds
   from the new settings differs from the one it builds from the old. A change that
   touches only post-filters, such as an excluded title, keeps the client's place.
4. Removed prospects are re-queued for tiering ONLY if the change touches something
   tiering reads: the buyer criterion, the headcount ceiling, the industries, the excluded
   industries or the keywords. That list is `TIERING_SPEC_FIELDS` in
   `src/lib/sourcing/tier-classification.ts`, and it is the type the tiering code is
   compiled against, so it cannot fall behind the code.

Both counts are logged at warn on every approval.

A rejection clears the proposal and changes nothing else. The ICP and the search still
disagree afterwards, so the next comparison files the proposal again unless the targeting
field is changed back.

**What to check if an approval misbehaves.**

- *"Reload and review it again" on every attempt.* The fingerprint the page was rendered
  with no longer matches the row. Something re-filed the proposal: look for
  `proposeIcpFilterSpec: targeting changed` in the log.
- *The next sourcing run after an approval found only people already held.* Read the
  `proposal approved` log line. `cursor_decision` says whether the request changed. A
  reset is correct when it did.
- *Removed prospects did not come back after an approval.* `requeue_fields` on the same
  log line is empty when the change touched nothing tiering reads. That is the rule, not
  a fault.

To see what is waiting, and to retry a proposal that failed:

    npx dotenv -e .env.local -- npx tsx scripts/propose-icp-filter-spec.ts

**Rollout record, 2026-10-01.** Done in the order ADR-061 fixes, because each step is only
safe after the one before it.

1. *Code.* Merged and read back as serving from the login page (`311d22fd`; the page read
   `6c0dabc6` before the merge).
2. *Cursor migration.* `20260930234500` applied to production. The function body in the
   database matched the committed file by md5 and length. No ICP had been promoted in between.
3. *Existing clients stamped.* `scripts/stamp-approved-filter-specs.ts` marked the three
   clients' live settings approved and stored the targeting fields they were built from. It
   first checked that each client's settings are what their current fields produce in effect.
   All three passed. One stores no revenue band because its settings predate the code that
   reads one. That is a stored-only difference: the band is not sent either way.

   Read back from the database, not from the script: each row carries the stored fields, the
   stamp and the operator's id, with nothing pending. Each client's built provider request was
   hashed before step 3 of ADR-061, before the stamp and after it, and is identical all three
   times. The first client's settings, less the one added key, are jsonb-equal to the archived
   version they were restored from on 2026-09-30.
4. *Replay.* A real pending suggestion that edits two trigger reasons was compared (2 of 215
   leaves differ, no targeting field) and then promoted inside a block that cannot commit.
   Settings, approval stamp, cursor offset and every prospect's verdict were unchanged.

**What an ICP approval does now, for a wording edit:** creates the new version with the same
settings and the same place in the search, and nothing else. To check one after the fact, the
new row's `icp_filter_spec` should jsonb-equal the previous row's, `icp_filter_spec_proposed`
should be NULL, and the client's `sourcing_cursors.record_offset` should not have moved.

The functions underneath are:

- `targetingInputs(document, outside)` copies the targeting fields out of a document.
- `compareTargetingInputs(before, after)` says whether they differ, which fields, and which
  parts of the settings would need rebuilding (geography, buyer criterion, fit dimensions).
- `diffSettings(live, proposed)` in `src/lib/sourcing/settings-diff.ts` says what a proposed
  set of search settings would change: fields added and removed, every exclusion that would
  stop applying, and whether the buyer criterion would still gate.

**The one thing that IS live from this step:** `deriveFilterSpec` and the geography reader
now accept only the targeting fields as their document. Their behaviour is unchanged. What
changed is that neither can come to read a field outside the list without a compile error.

**What to check if it breaks.**

- *An edit you expected to count as targeting did not, or the reverse.* Run it on the real
  documents. This prints the fields that differ and never the text:

      npx dotenv -e .env.local -- npx tsx scripts/show-targeting-change.ts --from <id> --to <id>
      npx dotenv -e .env.local -- npx tsx scripts/show-targeting-change.ts --suggestion <id>

- *`tsc` fails with "Unused '@ts-expect-error' directive" in
  `targeting-inputs.types.test.ts`.* Someone widened the targeting types so that prose is
  readable through them. That file is the test. Decide whether the new field really is a
  targeting field (an ADR-061 decision) before touching the directive.
- *A whitespace-only edit, or a reordered list, counted as a change.* That is deliberate.
  Values are compared exactly as written, because the alternative risks swallowing an edit
  somebody meant, and that failure is silent.

**Why one function and not a list of field names.** A list kept beside the code that reads
the fields falls behind it, and an edit to the forgotten field then silently stops counting.
Here the list is a type the derivation is written against, so the code can only read what
the list names.

**Exclusions are reported by name, never by count.** The 2026-09-30 re-derivation swapped two
excluded job titles for two others. The list stayed the same length, so a rule about length
would have passed it. `diffSettings` names every exclusion present before and absent after.

## Related


- `docs/dashboard.md`, "Operator quality review", for the removal counts on screen.
- `docs/BACKLOG.md`, "Silent sourcing defaults are now loud", for what was found and left.
- ADR-032 (sourcing filter hardcoded in the handler), ADR-036 (the 5-20 headcount band).
- ADR-061 (search settings change only through an approved proposal).

# PARTS 3–5 — The run, and the numbers

## PART 3 — The run

### The cohort as briefed did not match the database, and it was moving

`research_ran_at >= 2026-09-01` returns **63 rows, not 41**, and the maximum was timestamped
seconds before the query ran. Three separate runs landed against this organisation today:

| window (UTC) | prospects |
|---|---|
| 17:46:40 – 17:58:16 | 13 |
| 18:07:34 – 18:18:58 | 28 |
| **17:46 – 18:19 combined** | **41** ← the cohort |
| 19:20:07 – 19:24:44 | 22 ← a later, separate run |

The 41 is the 17:46–18:19 window. The later 22 were enqueued at 19:18 by
`operator:eee3436d-…`, and at the moment of checking one research job was still `claimed`
with an expired lease (`lease_expires_at` 19:26:40, `now()` 19:26:53, attempts 1 of 2).

**Something other than this session was running research against this organisation during
the session.** It did not touch the cohort: the still-claimed job's prospect has
`research_ran_at = null`, and the 41 showed `updated_at > 18:19` on zero rows. The cohort
was therefore pinned by explicit UUID rather than by the date predicate, and the 41 IDs are
in `.writer-export/` alongside the output.

### The brief was identical to the one the stored copy was written against

The comparison is only meaningful if both arms were briefed with the same messaging
document. The active-and-client-approved document is `61ed3cf8-6c49-4c8a-a17b-86c3068dee55`
v2, approved 2026-08-19 and unchanged since; v3 exists but is `archived` / `pending`, so the
production rule does not select it. `--messaging-doc-id` was therefore NOT used, and the
output confirms one document across all 41 records:

```
messaging_docs_used: [ '61ed3cf8-6c49-4c8a-a17b-86c3068dee55' ]
distinct doc ids:    [ '61ed3cf8-6c49-4c8a-a17b-86c3068dee55' ]
```

### Nothing was written

`--allow-overwrite-trigger` was not used. `export-writer-run.ts` was, which reads through an
allowlist proxy and hands `produceOpening` no database client at all.

The receipt is the cohort fingerprint, taken before the run and again immediately after:

| | before (19:27) | after (19:44) |
|---|---|---|
| row count | 41 | 41 |
| min research_ran_at | 2026-09-01 17:46:40.146+00 | 2026-09-01 17:46:40.146+00 |
| max research_ran_at | 2026-09-01 18:18:58.309+00 | 2026-09-01 18:18:58.309+00 |
| **max updated_at** | **2026-09-01 18:18:58.344636+00** | **2026-09-01 18:18:58.344636+00** |
| id-set md5 | `0bca2635bc6a6070850d97a3501728d9` | `0bca2635bc6a6070850d97a3501728d9` |
| personalisation_trigger md5 | `273ee1c3afef6f2bea8c87cb322b6616` | `273ee1c3afef6f2bea8c87cb322b6616` |
| personalisation_question md5 | `ecc34d9e700de8a971af4490feef89e8` | `ecc34d9e700de8a971af4490feef89e8` |
| personalisation_subject md5 | `f534cffaa1a96931119e5a01d2339b38` | `f534cffaa1a96931119e5a01d2339b38` |
| rows updated since run start | — | **0** |

`max(updated_at)` is the strongest single line: it still predates the run by 69 minutes.

### A false start, at no cost

The first invocation passed all 41 UUIDs as ONE argument. zsh does not word-split unquoted
parameter expansions, unlike bash. It failed on the first prospect lookup, **before any
model call**, so nothing was spent. Re-run through `xargs`.

### Cost

**$0.7061 total, $0.0172 per prospect**, across 173 model calls.

```
input          92,463
output         14,145
cache write     7,977
cache read    622,206
```

Cache reads outnumber cache writes 78 to 1, which is what a serial run buys. Per the
script's own note the figure is therefore a **floor**: a concurrent batch pays extra cache
writes at the head. It is derived from usage the API returned and is not an invoice. The
Anthropic console for today will also contain the unrelated 19:18 run, so a console
cross-check cannot be attributed to this run alone.

---

## PART 4 — Output for comparison

**`/Users/douglaspettit/Projects/margenticos/no-examples/.writer-export/CURRENT-vs-NO-EXAMPLES.md`**

41 entries, same order as the run, CURRENT above NO-EXAMPLES, observation / bridge /
question only. Nothing else in the file.

It holds real prospect copy for named people. `.writer-export/` is in `.gitignore`
(line 92) and this repository is currently PUBLIC, so the file is deliberately not
committed and must not be.

---

## PART 5 — Numbers

### Judge win rate

| | wins | run | rate |
|---|---|---|---|
| current cohort | 41 | 45 | 91.1% |
| **no-examples** | **37** | **41** | **90.2%** |

**These two rates are not like for like, and the difference is a selection effect rather
than a small decline.** The 41 are exactly the prospects that WON under the current prompt:
a prospect only holds a `personalisation_trigger` because its written opening beat the
template. The 4 that lost under the current prompt are not in the cohort and could not be,
because they have no stored copy to compare against. So the no-examples arm is being scored
on a set pre-selected for winnability, and 37/41 means **4 prospects that won under the
current prompt did not win without the examples**. A true 45-prospect comparison would need
the 4 original losers, which requires their findings and a separate run.

The 4 that did not win: two carried no gate failure at all on the final attempt and simply
lost the judge's comparison; one failed `claims not traceable to any finding: BDMs`; one
failed on length (bridge 36 against a target of 22) and on repeating the approved offer line.
All four exhausted their retries (2, 2, 1, 2).

### Gate failures by gate

Counted across every attempt, rejected attempts included. 39 in total, 0 unclassified.

| gate | count |
|---|---|
| length | 14 |
| offer_line_echo | 10 |
| untraceable_claim | 7 |
| sentence_initial_name | 5 |
| names_prospect | 2 |
| missing_question | 1 |

### Retries distribution

| retries used | prospects | share |
|---|---|---|
| 0 | 14 | 34.1% |
| 1 | 16 | 39.0% |
| 2 | 11 | 26.8% |

27 of 41 needed at least one rewrite.

### Length

Mean written block 57.1 words against a target of 58 and a hard cap of 67. Maximum 66. No
block breached the cap. 37 of 41 produced a subject line.

### The opening-reference measurement

Run through the shipped `findOpeningReferences`, which is exported for exactly this purpose,
over both arms of the same 41 prospects.

**Raw detector hits:**

| kind | CURRENT | NO-EXAMPLES |
|---|---|---|
| demonstrative | 30 | 24 |
| pronominal-one | 10 | 5 |
| pronoun | 0 | 0 |

**Every hit was then read and classified** as previous-sentence antecedent (genuine: the
pointer can only be resolved from an earlier sentence or from the observation paragraph) or
same-sentence antecedent (the sentence itself supplies what the pointer stands for).
Relative pronouns (`the thing that sits`), complementisers (`argues that services`), degree
modifiers (`a reputation that strong`) and temporal deictics (`this March`) resolve as
same-sentence and are not genuine.

**The method was validated before it was applied.** Classifying the CURRENT arm this way
returns **16 genuine demonstrative and 3 genuine pronominal-one**, which reproduces the
recorded baseline for this cohort exactly. Only then was the same classification applied to
the new arm.

| | CURRENT | NO-EXAMPLES |
|---|---|---|
| **genuine demonstrative** | **16** | **10** |
| **genuine pronominal-one** | **3** | **0** |
| non-genuine demonstrative | 14 | 14 |
| non-genuine pronominal-one | 7 | 5 |

Genuine demonstrative 16 → 10. Genuine pronominal-one 3 → 0: all five raw hits in the
no-examples arm resolve inside their own sentence (`either firm … the other one`,
`the partner … the one`, `the engagements … the current one`).

Per-hit classifications for both arms are in the session scratchpad worksheet, keyed by
prospect index, kind, part and sentence.

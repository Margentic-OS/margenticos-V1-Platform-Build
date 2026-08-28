# Apollo filter measurements: two ways a filter lies about itself

**Date:** 2026-08-28
**Method:** `mixed_people/api_search`, `per_page=1`, reading `total_entries` only.
No Apollo credits consumed (people search is free; organisation search is not and was
not used). Every number below changed exactly one parameter against a constant base.

These are findings in their own right, recorded separately from the build that acted on
them. Both are instances of the class CLAUDE.md already names ("Apollo silently ignores
unrecognised parameters, so an ignored filter looks identical to a working one"), and the
second one is **worse than that class**, which is why it is written up rather than
folded into a comment.

Reproduce with `npx dotenv -e .env.local -- npx tsx scripts/apollo-prove-filter.ts`.
The script regenerates its own table. Numbers in prose age; a harness does not.

---

## Finding 1 — the hardcoded consulting keywords decimate a non-consulting client

`deriveFilterSpec` hardcodes `keywords: ['consulting','consultant','advisory','consultancy']`
and the Apollo filter hardcodes
`q_organization_keyword_tags: ['management consulting','business consulting','strategy consulting']`.

Those tags are an **AND against NAICS**, not a union. Measured on a software-publisher
client (NAICS 5112):

| filter | total_entries |
|---|---|
| NAICS 5112, consulting keyword tags applied | **98** |
| NAICS 5112, keyword tags removed | **925** |
| NAICS 5112, keyword tags replaced with software terms | 925 |

**89% of the reachable pool removed, and the run still returns 98 rows.** That is the
damage: it does not fail, it does not empty, it produces a small plausible number. An
operator seeing 98 candidates has no signal that 827 were removed by a filter written for
somebody else's industry.

Note the third row. Software keyword tags gave the same count as no tags at all, so an
unrecognised tag VALUE is dropped rather than applied. Keyword tags therefore cannot be
proved by "the count moved" when the tag is one Apollo does not know.

For scale, the same hardcoding on the consulting base it was written for costs nothing,
which is exactly why it survived: it is invisible until the first non-consulting client.

## Finding 2 — Apollo silently widens an unrecognised administrative level to its country

The live 360 Bia Og ICP says *"Ireland, initially Munster (Waterford and surrounding
counties)"*. Measured against a constant base (NAICS 6111, schools):

| `organization_locations` | total_entries |
|---|---|
| `ireland` | 948 |
| `munster, ireland` (province) | **948** |
| `leinster, ireland` (province) | **948** |
| `connacht, ireland` (province) | **948** |
| `dublin, ireland` (city) | 499 |
| `cork, ireland` (city) | 28 |
| `waterford, ireland` (city) | 3 |
| `zzqq, ireland` (nonsense) | 0 |

All three Irish provinces return the exact whole-country count. Cities filter correctly.
Nonsense returns 0, so this is not a parse failure: Apollo matched `ireland` inside the
string and dropped `munster`.

**Why this is worse than the class CLAUDE.md already warns about.** An ignored parameter
returns the obviously-unfiltered count, and comparing against the baseline catches it. A
widened one returns a **plausible, narrower-looking number that is actually the country**.
Nothing in the count says which happened. If we had translated that ICP's geography prose
naively, 360 Bia Og would have been sourced across all of Ireland and every log would have
said the filter applied.

## Finding 3 — parameter strictness is not uniform, and it decides which assertion protects you

Found while building the harness, not before. Given a nonsense VALUE under a real
parameter name, Apollo does one of two things:

| parameter | nonsense value returns | strictness |
|---|---|---|
| `organization_naics_codes` | 0 | strict |
| `person_seniorities` | 0 | strict |
| `organization_locations` | 0 | strict |
| `organization_industry_tag_ids` | HTTP 422 | strict |
| `organization_num_employees_ranges` | **the baseline** | **lenient** |

A *misspelled parameter name* always returns the baseline (confirmed on
`organization_industry_xyz` and `person_seniorities_xyz`). So:

- **strict parameter** → a bad value is loud. Two independent guards.
- **lenient parameter** → a bad value is indistinguishable from omitting the parameter.
  Only the positive assertion protects it.

`organization_num_employees_ranges` is the lenient one, and it is the parameter carrying
the ADR-036 headcount stopgap. The existing comment beside it reasoned that a range string
Apollo failed to parse "would return a plausible number rather than an error" and used
partition arithmetic instead of trusting the count. **That reasoning was right and is now
measured.** Keep the arithmetic.

---

## The protocol this produces

Every canonical-to-tool mapping gets four assertions, not one. Implemented in
`scripts/apollo-prove-filter.ts`.

1. **Positive** — applying it moves the count off the baseline (the filter with that
   parameter absent).
2. **Parameter control** — the same value under a deliberately misspelled parameter name
   returns the baseline. If the real call matches this, the parameter is being ignored.
3. **Value control** — a nonsense value under the real name. Records the parameter's
   strictness (above). Fails only when it is indistinguishable from the real value.
4. **Granularity control** — locations only, and mandatory. The value's count must differ
   from its parent country's. This is the only assertion that catches Munster.

For enumerable axes, add partition arithmetic, but do not expect a clean sum on industries:
`5416` = 36,826, `6116` = 590, `5416+6116` = 37,186 rather than 37,416. The 230 residual is
firms carrying both codes. Multi-NAICS is a **union with overlap**. Headcount bands are
disjoint and do partition exactly; industries do not.

The harness ships with one deliberately failing probe (`munster, ireland`). It stays. A
proof harness with no known-bad case has never been shown to fail.

---

## Index drift, so the numbers are read correctly

The shipped base filter measured 36,818 on 2026-08-27 and 36,826 on 2026-08-28. That is
Apollo's index moving, not a change in the filter. Treat any difference under ~50 on this
base as drift, and re-run the harness rather than comparing against a number in a comment.

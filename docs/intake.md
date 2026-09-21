# intake.md — Intake Questionnaire Reference
# MargenticOS | Updated April 2026
# Cover: questionnaire flow, completeness logic, field reference, what to check if it breaks.
# The spec is in /prd/sections/05-intake.md.

---

## What this does

The intake questionnaire collects the raw input for the four strategy documents.
It is the only data source for document generation agents in phase one.

The form is built in `src/components/intake/IntakeForm.tsx`.
It auto-saves each field on blur. Currency and select fields save immediately on change.
The save action is in `src/app/intake/actions.ts` — it writes to `intake_responses` in Supabase.

---

## Completeness threshold

Document generation cannot begin until 80% of critical fields are completed.

- Total critical fields: **15**
- Threshold: **12 of 15** (`Math.ceil(15 * 0.8)`)
- The form header shows live progress toward the threshold

CORRECTED 2026-09-20. This said 16 and 13 for months. The code has said 15 and 12 since
`voice_samples` was removed in favour of file upload, and the numbers live in
`CRITICAL_COUNT` and `THRESHOLD` in `src/lib/intake/questions.ts`. Read them there; a figure
in this file is a copy and copies go stale.

**The denominator is a property of the question set, not of a client's rows.** Adding a
critical question therefore lowers EVERY existing client's completeness the moment it ships,
which is deliberate: it is how an unanswered new question becomes visible rather than reading
as 100%. The consequence is that adding critical questions to a live system is not a free
action. Measured on production 2026-09-20: four of five organisations sit at exactly 15 of 15,
so a single new critical question sends all four to 15/16 = 0.94, and five send them to
15/20 = 0.75, below the 0.8 that `/api/intake/complete` requires before it will dispatch.

If a critical open-text response is under 20 words, the form shows a follow-up nudge
inline beneath that field asking the client to add more detail.

---

## Sections and fields

### Section 1: company (7 questions, 6 critical)

| fieldKey | isCritical | Type |
|---|---|---|
| company_name | true | short text |
| company_url | false | short text |
| company_currency | true | currency selector (GBP / EUR / USD) |
| company_revenue_range | true | select — options driven by company_currency |
| company_what_you_do | true | long text |
| company_years_operating | true | short text |
| company_differentiators | true | long text |

### Section 2: clients (5 questions, 5 critical)

| fieldKey | isCritical | Type |
|---|---|---|
| clients_clone | true | long text |
| clients_trigger | true | long text |
| clients_how_found | true | long text |
| clients_what_tipped | true | long text |
| clients_channel | true | long text |

### Section 3: offer (4 questions, 4 critical)

| fieldKey | isCritical | Type |
|---|---|---|
| offer_structure | true | long text |
| offer_price | true | short text |
| offer_length | true | short text |
| offer_deliverables | true | long text |

### Section 4: voice (3 questions, 1 critical)

| fieldKey | isCritical | Type |
|---|---|---|
| voice_samples | true | long text |
| voice_style | false | long text |
| voice_dislikes | false | long text |

### Section 5: assets (2 questions, 0 critical)

`assets_website` was removed — `company_url` in Section 1 is the canonical website field.
Saving `company_url` triggers website ingestion automatically (see Website ingestion below).

| fieldKey | isCritical | Type |
|---|---|---|
| assets_existing_positioning | false | long text |
| assets_past_outreach | false | long text |

### Post-generation enrichment (4 questions, not shown in initial intake)

These fields exist in the schema but are surfaced in the dashboard after documents are generated,
not during intake. They do not affect the completeness threshold.

| fieldKey |
|---|
| enrich_recommend_words |
| enrich_unexpected_value |
| enrich_six_months |
| enrich_their_words |

---

## The buyer-targeting section (added 2026-09-20, inputs repaired 2026-09-20)

Four questions about WHO to contact: which countries, the buyer's headcount, the buyer's job
titles and seniority, whether that buyer can approve the spend alone, and who the client
would turn away anyway.

### What the first real client did with it, and what changed

**DATABASE-EVIDENCED**, read from production on 2026-09-20, organisation `0ed34697`, the only
row in the table. Three of five answers came back unusable, and none of the three failed in a
way anything reported:

| field | stored | why it is unusable |
| --- | --- | --- |
| `target_countries` | one entry naming three countries | resolves to no country at all |
| `buyer_job_titles` | one entry naming five titles, one misspelled | matches nobody |
| `signoff_required` | `true`, both role fields empty | the follow-up was never filled in |

**The countries and the titles are ONE defect in two places.** A single empty text box with
"Add another" underneath looks exactly like a box that takes the whole answer, because that is
what a single empty text box is everywhere else in this form. The list-ness sat below the
control and read as an afterthought for people with more to say.

The countries failure is the expensive one, because it is silent and delayed.
`toIso2CountryCode` resolves one country name; `toCanonicalCode` in the geography agent
REFUSES a name it cannot resolve and stops the derivation. So a combined string does not fail
at the form, it fails days later attached to a sourcing run.

**What changed:**

1. **Countries are a closed searchable multi-select**, not free text. The options are DERIVED
   from `COUNTRY_ALIASES`, one per ISO-2 code, by `selectableCountries()` in
   `src/lib/sourcing/country-code.ts`. Never a second list beside the table: a country offered
   and missing from the table is one the geography derivation refuses, and a country in the
   table and missing here is unreachable. A test asserts every option round-trips.
   The NAME is stored, not the code, because two live consumers read this value as words: it
   is interpolated into the ICP prompt as the binding value of `company_profile.geography`,
   which lands in a document a client reads, and a single stated country becomes the geography
   term appended to a web search query.
2. **`buyerProfileToRow` validates countries**, via `normaliseCountries`, so the write path
   refuses a combined string even when the request did not come through the browser. It does
   NOT split one: guessing a delimiter is the parser this table exists to avoid, and a value
   that was three answers in one box is a question to re-ask.
3. **"Who should we email first?" is deleted.** It collected the same answer as the job titles
   question, and two questions competing for one answer get two answers that disagree. The
   client who met it left it blank. **The column is untouched** and a stored value rides
   through the form unchanged, so no save blanks an earlier answer.
4. **The sign-off question now hangs off the buyer already described**, and ITS POLARITY IS
   INVERTED while the storage is not: "Yes" means the buyer can approve alone, which is
   `signoff_required = false`. The label/boolean pairing is data in `SIGNOFF_ANSWERS`, not two
   hand-written booleans in two click handlers.
5. **Every remaining list says it is a list** before anything is typed: a hint line above the
   first row, numbered rows, and a button naming what it produces. The job titles CONTROL was
   deliberately not rebuilt; it is being replaced with chips and model expansion.

**The live row was repaired** on 2026-09-20 to three separate countries and five separate
titles, with `Woner` corrected to `Owner`. One row, scoped by its exact prior values. Its
`signoff_role` is still empty and `signoff_required` still `true`: the data was left alone and
the rewritten control is what makes it answerable.

**They are not in `SECTIONS`, and that is deliberate.** Two things follow automatically from
being in `SECTIONS`, and neither is wanted yet:

1. Every question in `SECTIONS` is rendered into the prompt of all four document-generation
   agents by `mergeIntakeWithQuestions`. A question added there begins changing generated
   documents as soon as a client answers it, without any agent being edited.
2. Every critical question in `SECTIONS` enters the completeness denominator, with the
   consequence measured above.

**Who reads them (updated 2026-09-20, second session).** The ICP path does, and nothing
else. A test in `src/lib/intake/__tests__/buyer-profile.test.ts` scans the agent, sourcing,
composition and tuner trees and fails if any file outside a short allow-list imports the
module. The allow-list is two files and each has to say why it is there:

| file | what it reads | why |
| --- | --- | --- |
| `src/agents/icp-generation-agent.ts` | all nine | renders them into the prompt as binding on named schema fields |
| `src/lib/sourcing/persist-icp-filter-spec.ts` | the headcount pair | so the spec does not parse prose for a client who answered |

The test runs the other way too: a file ON the allow-list that has stopped reading them
fails it, so an exemption cannot outlive its caller.

**How they reach the ICP.** `buildBuyerProfileBlock` in
`src/lib/intake/buyer-profile-authority.ts` renders a block placed LAST in the user message,
after the research, the website, the uploaded documents and the previous version of the
document, because it says it beats all of them and an instruction is read after the thing it
overrides. Each entry names the schema field it binds:

| answer | binds |
| --- | --- |
| `target_countries` | `company_profile.geography`, tiers 1 and 2 |
| `buyer_headcount_min` / `_max` | `company_profile.headcount`, tiers 1 and 2 |
| `buyer_job_titles` | `buyer_profile.title`, tiers 1 and 2 |
| `buyer_seniority_bands` | `buyer_profile.seniority`, tiers 1 and 2 |
| `disqualifiers` | `tier_3.disqualifiers`, which may not drop one |
| `first_contact_role` | who `buyer_profile` is about. NO LONGER COLLECTED; see above. The block omits it for an empty value, which is now every new client |
| `signoff_required` / `signoff_role` | `four_forces.anxiety` and `buyer_profile.day_to_day` |

Tier 3 takes only the disqualifiers. It is the do-not-target tier, so binding a targeting
answer into it would make the disqualifier tier describe the target.

**An organisation with no row gets no block at all**, not an empty one, and its prompt is
byte-identical to the one it got before these questions existed. Four of the five live
organisations are in that state, so this is the ordinary case rather than the edge. The same
holds field by field: a client who named countries and skipped the headcount question leaves
the headcount rules in the prompt untouched.

**Two things that are NOT retroactive.** Nothing regenerates a document, and nothing rebuilds
a filter spec. A client editing an answer flags the live ICP stale (see below) and an
operator decides; the spec is rebuilt at the next ICP approval. Prospects already sourced or
uploaded under the old spec are untouched, per ADR-034.

**An edit now flags the ICP stale.** All nine fields moved from `NOT_MAPPED` into
`DOCUMENTS_FED_BY_FIELD` in `src/lib/intake/document-staleness.ts` in the same commit that
gave them a reader. The save path already called the flagging helper for every changed field,
so the map entry was the only thing missing.

**Storage is typed, in its own table.** `public.intake_buyer_profile`, one row per
organisation, created by `supabase/migrations/20260920140000_intake_buyer_profile.sql`:

| column | type | notes |
| --- | --- | --- |
| `organisation_id` | uuid PK | cascades on organisation delete |
| `target_countries` | text[] | one country per entry, the canonical name from `COUNTRY_OPTIONS`; validated on write |
| `buyer_headcount_min` / `_max` | integer | both set or both null (CHECK); min >= 1; max >= min |
| `buyer_job_titles` | text[] | |
| `buyer_seniority_bands` | text[] | provider tokens, validated in the application |
| `first_contact_role` | text | NO LONGER WRITTEN by the form. Column kept; see the decision note below |
| `signoff_required` | boolean | NULL means not answered, which is not "no" |
| `signoff_role` | text | cleared when sign-off is not required |
| `disqualifiers` | text[] | |

It is a table rather than rows in `intake_responses` because that table stores every value in
one `text` column. Two of these answers are integers a filter is built from and three are
lists, and putting either in a text column means choosing a delimiter and writing a parser on
the read side. A consumer here reads two integers and three arrays and parses nothing.

**Seniority options are read from the provider handler**,
`src/lib/sourcing/handlers/provider-seniority.ts`, never retyped. A test asserts that no band
token appears as a string literal anywhere in the intake code.

**What to check if it breaks**

- Answers not saving: the save path is `saveBuyerProfile` in
  `src/app/intake/buyer-profile-actions.ts`. It resolves the organisation from the signed-in
  user and never accepts one from the caller.
- A country the client wants and cannot find: the list is every ISO-2 code in
  `COUNTRY_ALIASES`. Adding the country there adds it to the control, with no edit anywhere
  else, and a test proves the new entry resolves.
- A headcount rejected: `parseHeadcount` in `src/lib/intake/buyer-profile.ts` refuses half a
  range, an inverted range, anything below 1, and anything that is not a plain whole number.
  The database repeats all of that as CHECK constraints.
- Nothing appears for an existing client: they have no row until their first save, which reads
  back as an empty profile rather than an error.

**Staleness mapping.** All nine fields are in `NOT_MAPPED` in
`src/lib/intake/document-staleness.ts`. That is not the list being lazy: the map means
"documents built directly from this answer", and no document is built from any of them yet.
The write path already calls the flagging helper for every changed field, so the only step
needed to make a stale flag work is adding the field to `DOCUMENTS_FED_BY_FIELD`. The session
that gives one of these a reader maps it in the same commit.

---

## Dictation prompt

A prompt at the top of the form tells clients to speak their answers rather than type them,
referencing Wispr Flow. Individual long-text questions marked with `dictation: true` in the
component show a shorter inline prompt: "Speak this one if you can."

---

## What to check if it breaks

**Field not saving:**
- Check `src/app/intake/actions.ts` — the save action validates session and client_id before writing
- Check Supabase `intake_responses` table — RLS policies require authenticated user with matching org

**Threshold not unlocking document generation:**
- CRITICAL_COUNT is derived at build time from the question definitions in IntakeForm.tsx
- If questions are added or isCritical is changed, the threshold recalculates automatically
- Verify the count in the component: `ALL_QUESTIONS.filter(q => q.isCritical).length` should be 16

**Currency options not updating:**
- company_revenue_range options are driven by company_currency via the `revenueOptions` helper
- If company_currency is not yet saved, the symbol defaults to £

**iOS Safari input zoom:**
- All inputs use `text-[16px]` — do not reduce below 16px or iOS will zoom on focus

---

## Website ingestion

When a client saves `company_url` in Section 1, the form fires a fire-and-forget
`POST /api/intake/website/fetch` with the URL. The API route:

1. Authenticates the user and resolves their `organisation_id`
2. Calls `src/lib/intake/fetch-website.ts` — fetches homepage + discovers up to 3 inner pages (About, Services, Case Studies) by scoring same-domain anchor tags
3. Replaces all existing rows in `intake_website_pages` for that org (delete + insert)

Results are stored in the `intake_website_pages` table. Each row has `fetch_status` of
`complete` or `failed`. Agents skip failed rows silently.

ICP, TOV, and Positioning agents all call `fetchWebsiteContext()` from
`src/lib/agents/website-context.ts` to read the successfully-fetched pages.
Content is injected into the prompt after uploaded files and before web research.

**What to check if website content is missing from agent output:**
- Check `intake_website_pages` in Supabase — are rows present for the org? What is `fetch_status`?
- If `fetch_status = 'failed'`, check `error_message`: `timeout`, `http_403`, `fetch_error`, `invalid_url`
- Many sites block headless fetches with 403. This is non-fatal — agents proceed without it.
- Re-saving the `company_url` field in the intake form triggers a re-fetch.

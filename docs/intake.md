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

- Total critical fields: **16**
- Threshold: **13 of 16** (`Math.ceil(16 * 0.8)`)
- The form header shows live progress toward the threshold

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

### Section 5: assets (3 questions, 0 critical)

| fieldKey | isCritical | Type |
|---|---|---|
| assets_website | false | short text |
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

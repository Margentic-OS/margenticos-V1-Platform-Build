# sections/05-intake.md — Questionnaire, File Upload, Website Ingestion
# MargenticOS PRD | April 2026 — updated with five-theme framework, currency selector, split fields
# Read prd/PRD.md first, then this section when working on intake, onboarding, or document generation inputs.

---

## Purpose

The intake questionnaire collects the raw material for the four strategy documents.
It is the only input source for document generation agents in phase one.
Quality in = quality out. A poorly completed intake produces a generic document.

The question set is structured around five intelligence themes:
  Identity, Decision Journey, Experience, Tipping Point, Reflection.
These are not labels shown to the client. They are the architectural backbone
that determines what each question is trying to extract.

Every question is designed to surface language the client already uses —
not language they construct in response to a prompt.
The intake is a listening exercise, not a strategy workshop.

---

## Completeness threshold

Document generation cannot begin until 80% of critical fields are completed.
Critical fields are tagged with is_critical = true in intake_responses.
Not all fields are critical — some are enrichment only and do not block generation.

If a critical open-text response is under 20 words:
  - The system prompts one specific follow-up question
  - The follow-up must be answered (or explicitly skipped) before moving to the next section
  - Do not ask multiple follow-up questions at once — one specific question only

---

## Dictation prompt

At the top of the questionnaire, before the first question, display this exact text:

  "The quality of your strategy documents depends entirely on what you put in here.
   Thin answers produce generic documents.

   If you can, speak your answers rather than type them — people say 3x more when
   talking than typing, and that extra detail is what makes the difference.
   We recommend Wispr Flow for Mac users: wisprflow.ai

   Don't edit yourself. Raw and honest beats neat and vague every time."

On each open-text narrative question (marked below), display a shorter inline prompt:
  "Speak this one if you can — it'll take 60 seconds and give us much more to work with."

Agents must handle raw dictation input gracefully. Intake responses may contain
filler words, repeated thoughts, and no punctuation. Extract signal from the substance,
not the structure. Do not penalise or flag unpolished language in intake responses.

---

## Questionnaire sections

### Section 1: company
Maps to: all four strategy documents (foundational context)

  field_key: company_name
  Label: What's your company name?
  is_critical: true
  Type: short text

  field_key: company_url
  Label: What's your website URL?
  is_critical: false
  Type: short text (URL)
  Note: also used by website ingestion agent — same as assets_website

  field_key: company_currency
  Label: What currency do you work in?
  is_critical: true
  Type: select
  Options: GBP (£) / EUR (€) / USD ($)
  Note: controls the currency symbol shown in the revenue range options

  field_key: company_revenue_range
  Label: What's your current annual revenue range?
  is_critical: true
  Type: select
  Options: dynamic — symbol matches company_currency selection
    GBP: Under £100K / £100K–£300K / £300K–£600K / £600K–£1M / £1M–£2M / Over £2M
    EUR: Under €100K / €100K–€300K / €300K–€600K / €600K–€1M / €1M–€2M / Over €2M
    USD: Under $100K / $100K–$300K / $300K–$600K / $600K–$1M / $1M–$2M / Over $2M

  field_key: company_what_you_do
  Label: Who do you help and what problem do you solve for them?
  is_critical: true
  Type: long text
  Dictation prompt: yes

  field_key: company_years_operating
  Label: How long have you been operating?
  is_critical: true
  Type: short text

  field_key: company_differentiators
  Label: What makes your firm genuinely different from others who do what you do?
        Not the marketing answer — the real one.
  is_critical: true
  Type: long text
  Dictation prompt: yes

Section total: 7 questions, 6 critical

---

### Section 2: clients
Maps to: ICP document, messaging framework, outreach personalisation
Theme coverage: Identity, Decision Journey, Tipping Point

  field_key: clients_clone
  Label: Think about your single best client — the one you'd clone if you could.
         Describe them. Not their job title. What makes them different to work with?
         What do they believe or understand that most of your clients don't?
  is_critical: true
  Type: long text
  Dictation prompt: yes

  field_key: clients_trigger
  Label: When your best clients first came to you, what was happening in their business?
         What had changed, broken, or become urgent enough that they finally did something?
  is_critical: true
  Type: long text
  Dictation prompt: yes

  field_key: clients_how_found
  Label: Walk me through how your last best client found you.
         Start from the beginning — how did they first become aware you existed?
  is_critical: true
  Type: long text
  Dictation prompt: yes

  field_key: clients_what_tipped
  Label: What do you think actually tipped them toward working with you?
         Not the polished answer — the real one.
         Was there a specific conversation, a moment, something you said or showed them?
  is_critical: true
  Type: long text
  Dictation prompt: yes

  field_key: clients_channel
  Label: Do your best clients typically come from referrals, inbound, or outbound?
         What does that usually look like in practice?
  is_critical: true
  Type: long text

Section total: 5 questions, 5 critical

---

### Section 3: offer
Maps to: ICP document, positioning document, outreach sequences
Theme coverage: foundational — required by all agents

  field_key: offer_structure
  Label: How does your service actually work? What does a client buy and what does
         the engagement look like?
  is_critical: true
  Type: long text

  field_key: offer_price
  Label: What's the price point or range for your core offer?
  is_critical: true
  Type: short text

  field_key: offer_length
  Label: How long does a typical engagement last?
  is_critical: true
  Type: short text

  field_key: offer_deliverables
  Label: What does a client actually get? Deliverables, outputs, access —
         what exists at the end that didn't before?
  is_critical: true
  Type: long text
  Dictation prompt: yes

Section total: 4 questions, 4 critical

---

### Section 4: voice
Maps to: tone of voice document
Theme coverage: foundational for TOV agent

  field_key: voice_samples
  Label: Paste 3–5 examples of how you write naturally.
         Emails, LinkedIn posts, messages to clients — the more unpolished the better.
         We're looking for your real voice, not your best work.
  is_critical: true
  Type: long text (multi-sample, separated by line breaks)
  Note: client may also upload files — see File Upload section below

  field_key: voice_style
  Label: How would you describe your communication style in your own words?
  is_critical: false
  Type: long text

  field_key: voice_dislikes
  Label: Is there anything you hate seeing in business communication?
         Phrases, styles, tones that make you cringe.
  is_critical: false
  Type: long text

Section total: 3 questions, 1 critical

---

### Section 5: assets
Maps to: positioning document (enrichment), website ingestion
Theme coverage: enrichment only — does not block generation

  field_key: assets_website
  Label: What's your website URL? We'll read it as part of building your strategy.
  is_critical: false
  Type: short text (URL)
  Note: triggers website ingestion agent if provided

  field_key: assets_existing_positioning
  Label: Is there any positioning or messaging you currently use that you'd like us to know about?
         Could be a tagline, an about page, a pitch you've used.
  is_critical: false
  Type: long text

  field_key: assets_past_outreach
  Label: Have you tried outbound before? What worked and what didn't?
         Even partial attempts count.
  is_critical: false
  Type: long text

Section total: 3 questions, 0 critical

---

### Post-generation enrichment prompts
Surfaced after documents are generated, not during initial intake.
Displayed as "Help us go deeper" prompts in the dashboard strategy view.
These are not shown during initial intake flow — they appear once generation is complete.
Theme coverage: Experience, Reflection

  field_key: enrich_recommend_words
  Label: When a happy client recommends you to someone else, what do they actually say?
         If you've heard it directly — a referral conversation, a message, a testimonial —
         give us the closest thing to their exact words.
  is_critical: false
  Type: long text
  Dictation prompt: yes

  field_key: enrich_unexpected_value
  Label: What do clients get from working with you that they didn't expect when they signed up?
         The thing they mention that you didn't necessarily promise.
  is_critical: false
  Type: long text
  Dictation prompt: yes

  field_key: enrich_six_months
  Label: Six months after a successful engagement, what's specifically different for your client?
         Not the feeling — the thing they can point to.
  is_critical: false
  Type: long text
  Dictation prompt: yes

  field_key: enrich_their_words
  Label: Have any clients told you — in a review, a message, a conversation — what changed for them?
         Give us the closest thing to their exact words, even if it was informal.
  is_critical: false
  Type: long text
  Dictation prompt: yes

Post-generation total: 4 questions, 0 critical

---

## Summary

  Section         Questions   Critical
  company         7           6
  clients         5           5
  offer           4           4
  voice           3           1
  assets          3           0
  enrichment      4           0
  ———————————————————————————————————
  Total           26          16

  80% threshold = 13 of 16 critical fields completed before generation triggers.
  Enrichment prompts are surfaced post-generation only — not part of initial intake flow.

---

## File upload

Clients can upload documents to support intake:
  - PDFs, Word documents, plain text files
  - Maximum file size: 10MB per file
  - Maximum files: 10 per organisation
  - Files stored in Supabase Storage under the organisation's folder

Supported upload types:
  - Writing samples (for TOV agent)
  - Existing positioning documents
  - Client testimonials
  - Case study drafts

Files are processed by the file-reading agent at document generation time.
They are not processed immediately on upload.

---

## Website ingestion

If assets_website is provided:
  - The agent fetches the homepage and up to 3 inner pages (About, Services, Case Studies)
  - Extracted text is stored as an intake_response for the relevant field_key
  - Used as additional context for positioning and TOV agents
  - A failed fetch (404, timeout, bot-blocked) is logged but does not block document generation

---

## Updates after initial intake

Clients can update intake responses at any time from the dashboard.
Updates trigger document refresh suggestions in the document_suggestions queue.
They do not trigger full document regeneration automatically.

If an update affects a critical field (particularly ICP or positioning inputs),
the agent evaluates whether the change is meaningful enough to warrant a new suggestion.
Threshold: a meaningful update changes the substance of the answer, not just the wording.

The 90-day document refresh email clock resets on meaningful intake updates.

---

## What not to build in phase one

  - Real-time collaborative intake editing (multi-user simultaneous editing)
  - Intake scoring or progress percentage shown to the client (operator view only)
  - Automated intake completion reminders (add in phase two)
  - Voice-to-text dictation button built into the form (add in phase two)
    Note: UI prompt directing clients to use native browser/phone dictation is phase one
  - Post-generation enrichment prompt logic (add in phase two — schema and field_keys exist now)

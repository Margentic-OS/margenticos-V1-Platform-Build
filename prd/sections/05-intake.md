# sections/05-intake.md — Questionnaire, File Upload, Website Ingestion
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when working on intake, onboarding, or document generation inputs.

---

## Purpose

The intake questionnaire collects the raw material for the four strategy documents.
It is the only input source for document generation agents in phase one.
Quality in = quality out. A poorly completed intake produces a generic document.

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

## Questionnaire sections

The intake is divided into sections. Each section maps to one or more document inputs.

### Section 1: The business
  - Company name and URL (critical)
  - What the business does — in plain English (critical)
  - How long operating (critical)
  - Current revenue range (critical)
  - Team size
  - Key differentiators — what makes this firm different from the next one (critical)

### Section 2: The clients
  - Best client description — who, what industry, what role (critical)
  - What problem brings them to you — before they found you (critical)
  - What outcome did they get — specific, concrete results (critical)
  - Why do they choose you over alternatives (critical)
  - Do clients typically come from referrals, inbound, or outbound (critical)
  - Three or more example clients — name, role, company if comfortable (enrichment)

### Section 3: The offer
  - What is being sold — the service or engagement structure (critical)
  - Price point or range (critical)
  - Typical engagement length (critical)
  - What does a client get — deliverables, outputs, access (critical)
  - What does a typical engagement look like week by week

### Section 4: The founder's voice
  - Writing samples — 3–5 examples of how the founder naturally writes (critical)
    (LinkedIn posts, emails, Slack messages, anything unpolished and real)
  - How would you describe your communication style in your own words
  - Anything you hate seeing in business communication

### Section 5: Existing marketing assets
  - Website URL for ingestion (enrichment)
  - Existing positioning or messaging they use (enrichment)
  - What has and hasn't worked in past outreach attempts (enrichment)

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

If a website URL is provided in intake:
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
- Voice-to-text intake (add later)

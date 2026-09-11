# sections/13-integrations.md — Registry Pattern, Each Tool, Webhook Events, Setup
# MargenticOS PRD | April 2026
# Read prd/PRD.md first and sections/02-stack.md for the registry pattern.
# Then read this section when setting up or modifying any integration.

---

## The registry pattern — always first

Before building any integration, register the tool in integrations_registry.
No agent or component may reference a tool name directly in code.
All external tool calls go through the capability handler pattern.

See sections/02-stack.md for the full pattern and the executeCapability function.
See ADR-001 and ADR-010 in /docs/ADR.md for the architectural decisions.

---

## Instantly — can_send_email

Purpose: Cold email sequence management and sending.
Capability: can_send_email

What MargenticOS builds:
  - Create and manage sequences via Instantly API
  - Add prospects to sequences
  - Pause / resume sequences per prospect (OOO handling, suppression)
  - Receive webhooks for reply events, bounces, spam complaints, sequence completion

What MargenticOS does NOT build:
  - Email composition UI (sequences are built programmatically)
  - Sending infrastructure (Instantly handles all sending)
  - Email signature management (configured per client in Instantly workspace directly)

Webhook events to handle:
  reply_received          → route to reply handling agent
  bounce                  → record signal, flag if rate exceeds threshold
  spam_complaint          → record signal, immediate suppression check
  sequence_completed      → signal for pattern library (phase two)
  prospect_unsubscribed   → immediate suppression

API setup steps (when configuring for a client):
  1. Doug creates a dedicated Instantly workspace (or sub-account) per client
  2. Connect the client's sending domain in Instantly
  3. Configure DKIM / SPF / DMARC (Instantly provides instructions)
  4. Enter Instantly API key in integrations_registry config for this client
  5. Configure webhook URL pointing to /api/webhooks/instantly in Instantly settings
  6. Verify webhook receipt with a test event

Sending limits (always configured):
  Warmup period: start at 20–30 emails/day, ramp over 4–6 weeks
  Steady state: 50–100 emails/day per sending domain (client-dependent)
  These limits are set in Instantly, not in MargenticOS

---

## Taplio — can_schedule_linkedin_post

Purpose: LinkedIn content delivery. Taplio receives approved posts for publishing.
Capability: can_schedule_linkedin_post

IMPORTANT — content delivery model, not scheduling API:
  Taplio has no public API for programmatic post scheduling (verified April 2026).
  Taplio also had its own LinkedIn page temporarily restricted in 2024 due to
  cookie-based automation — there is genuine platform risk in unofficial API access.
  See ADR-004 and ADR-010 in /docs/ADR.md.

How the integration works:
  1. Agent generates LinkedIn post content for a client
  2. Post appears in the MargenticOS dashboard approval queue
  3. Client (or auto-approve timer) approves the post in the dashboard
  4. Post status set to "approved — ready for delivery"
  5. Doug receives notification that post is approved and ready
  6. Doug manually queues the post in Taplio (or via Zapier automation)
  7. Taplio publishes to LinkedIn at the scheduled time

The can_schedule_linkedin_post handler:
  - Marks the post as approved in MargenticOS
  - Sends a notification to Doug with the post content
  - Does NOT make any API call to Taplio
  - Does NOT attempt any form of programmatic Taplio interaction

What MargenticOS does NOT build:
  - Any direct API integration with Taplio
  - Cookie-based or session-based automation with Taplio
  - Any programmatic LinkedIn posting tool

Taplio setup steps (per client):
  1. Doug connects the client's LinkedIn account in Taplio
  2. Post content is delivered to Taplio queue manually by Doug or via Zapier
  3. No API keys or credentials from Taplio are stored in MargenticOS

---

## Lemlist — can_send_linkedin_dm

Purpose: LinkedIn DM outreach and sequence management.
Capability: can_send_linkedin_dm

What MargenticOS builds:
  - Create and manage LinkedIn DM sequences via Lemlist API
  - Add prospects to DM sequences
  - Receive webhooks for DM reply events and connection acceptances
  - Pause sequences on suppression

What MargenticOS does NOT build:
  - LinkedIn connection management UI
  - DM composition UI (sequences built programmatically)

Webhook events to handle:
  dm_reply_received       → route to reply handling agent
  connection_accepted     → record signal, trigger DM sequence if configured

Sending limits (always configured):
  Connection requests: ~20–30 per day per LinkedIn account
  DMs: ~50–80 per day per LinkedIn account
  These limits protect client LinkedIn accounts from restriction
  Configure in Lemlist, not in MargenticOS

API setup steps (when configuring for a client):
  1. Doug creates a Lemlist account (or sub-account) for the client's LinkedIn
  2. Connect the client's LinkedIn account in Lemlist
  3. Enter Lemlist API key in integrations_registry config
  4. Configure webhook URL pointing to /api/webhooks/lemlist
  5. Verify webhook receipt with a test event

Note: Verify Lemlist API capabilities before beginning phase two build.
      API access and endpoint availability should be confirmed against live documentation.

---

## Apollo — can_enrich_contact

Purpose: Prospect enrichment and contact data.
Capability: can_enrich_contact

What MargenticOS builds:
  - Prospect lookup by name + company
  - Contact enrichment (email, LinkedIn URL, role, company data)
  - Used as step 1 in the Trigger-Bridge-Value prospect research sequence

What MargenticOS does NOT build:
  - Apollo sequence management (not needed — Instantly handles sequences)
  - Apollo CRM features

Token budget: 1 Apollo API call per prospect in the research sequence.

API setup steps:
  1. Doug creates an Apollo account
  2. Enter Apollo API key in integrations_registry config
  3. Configure per-client Apollo workspace if needed for list separation

---

## GoHighLevel — CRM and meeting tracking

Purpose: CRM, meeting tracking, and client communication relay.
Capability: Not registered as a single capability — used as a CRM layer.

What MargenticOS uses GHL for:
  - Tracking meeting outcomes (qualified / unqualified / no-show)
  - Sending information request replies on client's behalf (Doug-operated)
  - Client communication history

What MargenticOS does NOT build:
  - A custom CRM — GoHighLevel is the CRM
  - Meeting booking — Cal.com (ADR-054) or manual recording for any other tool

Integration approach:
  Meeting outcome signals flow from GHL to MargenticOS via webhook.
  Doug updates meeting status in GHL; webhook fires to MargenticOS signals table.

Webhook events:
  contact_stage_changed   → update meeting qualification in meetings table
  meeting_status_updated  → record outcome signal

---

## Cal.com — can_book_meeting (ADR-054, 2026-09-11)

Purpose: the booking link in positive reply emails, and detection of the meeting that
results.
Capability: can_book_meeting

What MargenticOS builds:
  - Store the client's booking link in organisations.booking_url, edited in operator Settings
  - Put it in reply emails with the prospect's reference attached (prospect_ref)
  - One signed webhook, /api/webhooks/cal-com, that records booked, cancelled and
    rescheduled meetings, finding the client by the hosting seat and the prospect by the
    reference, then by email. An unmatched booking is recorded, never discarded.

What MargenticOS does NOT build:
  - A booking system or calendar
  - Held-meeting detection: Cal.com's meeting-ended event fires whether or not anyone
    attended, so held stays an operator judgement

Setup: one Cal.com organisation of ours; each client a seat with their own calendar
       connected (client seats not yet built). Doug enters the booking link in Settings.

---

## Resend — transactional email from MargenticOS

Purpose: Send system emails from MargenticOS (approval notifications, 90-day refresh).
This is NOT registered in integrations_registry — it is a platform-level dependency.

Used for:
  - Approval notification emails to clients and Doug
  - 90-day document refresh emails
  - Escalation reminder emails for information requests

Setup: Resend API key stored in environment variables. Verified domain in Resend.

---

## Hunter.io — can_validate_email (phase two)

Purpose: Email validation before adding prospects to sequences.
Capability: can_validate_email

Phase one: not built. Register the capability in integrations_registry with is_active = false.
Phase two: build the handler and activate.

---

## Webhook security

All webhook endpoints must verify the HMAC signature from the sending platform.
Never accept a webhook payload without signature verification.
Invalid signatures: return 401, do not process, log the attempt.
Valid signatures: process normally, return 200 immediately (process async if needed).

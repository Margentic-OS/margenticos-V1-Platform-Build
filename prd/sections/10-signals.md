# sections/10-signals.md — Signal Types, Processing, Pattern Library
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when working on signals, webhooks, or the pattern library.

---

## Signal types

Signals are campaign performance events that feed the warnings engine and feedback loop.
All signals are stored in the signals table with client isolation enforced.

### Email signals (from Instantly webhooks)
  email_open              Email opened (directional only — not high confidence alone)
  email_click             Link clicked in email
  email_reply             Any reply received (routed to reply handling agent for classification)
  email_bounce            Hard or soft bounce
  email_spam              Spam complaint filed

### LinkedIn post signals (from Taplio/manual)
  linkedin_post_like      Post received a like
  linkedin_post_comment   Post received a comment
  linkedin_post_share     Post was shared

### LinkedIn DM signals (from Lemlist webhooks)
  linkedin_dm_reply       DM received a reply (routed to reply handling for classification)
  linkedin_connection_accepted  Connection request accepted

### Meeting signals (from GoHighLevel)
  meeting_qualified       Meeting marked as qualified by Doug or client
  meeting_unqualified     Meeting marked as not a fit
  meeting_no_show         Prospect didn't attend

### Reply classification signals (output of reply handling agent)
  positive_reply          Prospect expressed interest
  information_request     Prospect asked a question
  opt_out                 Prospect asked to be removed
  out_of_office           OOO detected and handled

---

## Signal processing — phase one scope

In phase one, signal processing is logging and classification only.

When a signal arrives (via webhook or manual trigger):
  1. Store the raw webhook payload in signals.raw_data
  2. Set signal_type to the appropriate type above
  3. Link to prospect_id and campaign_id where available
  4. Set processed = false
  5. Signal processing agent classifies and processes it
  6. Set processed = true, processed_at = now()

Phase one does NOT evaluate signals against threshold logic or generate suggestions.
That is phase two work — see sections/07-feedback-loop.md and ADR-011.

---

## Webhook setup

Webhooks must be configured in each tool to send events to the MargenticOS API.

  Instantly:  Configure webhook in Instantly workspace settings.
              Events: reply received, bounce, spam complaint, sequence completed.
              Endpoint: /api/webhooks/instantly

  Lemlist:    Configure webhook in Lemlist settings.
              Events: reply received, connection accepted.
              Endpoint: /api/webhooks/lemlist

  GoHighLevel: Configure webhook or Zapier trigger.
              Events: meeting status changed, contact updated.
              Endpoint: /api/webhooks/ghl

All webhook endpoints require HMAC signature verification.
Never accept a webhook payload without verifying its signature.

---

## Pattern library

The patterns table contains anonymised, aggregated insights across all clients.
Written ONLY by the pattern aggregation agent. Never by any other code.

### What gets patterned (phase two and beyond)
  Subject line performance by type, tone, and length
  Opening line effectiveness by trigger type
  CTA performance (link vs meeting request vs question)
  Sequence length sweet spots
  Optimal follow-up timing
  ICP tier conversion patterns

### Phase one expectations
The pattern library will be sparse for months.
With 3–5 founding clients, meaningful cross-client patterns won't emerge for weeks.
This is expected and fine.

Agents must handle empty pattern query results gracefully:
  - Default to per-client signal history when patterns are empty
  - Never fail or produce errors if the patterns table returns nothing
  - Never force patterns — they emerge from signal volume over time

The pattern library's value compounds as more clients and more campaigns accumulate.
Do not try to accelerate it artificially in phase one.

---

## Signal data privacy

Signals contain campaign performance data that is client-confidential.
RLS enforces that signals are only readable by the operator or by the client's own organisation.
The pattern library strips all client identifiers before writing — only aggregated insights.
No raw signal data from Client A ever appears in any query run in the context of Client B.

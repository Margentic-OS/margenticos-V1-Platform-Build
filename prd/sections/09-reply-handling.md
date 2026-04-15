# sections/09-reply-handling.md — Reply Types, Routing, Escalation, Opt-Out
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when working on reply handling.

---

## Reply classification

All incoming email replies are classified by the reply handling agent into four types:
  1. Positive reply (wants to book a meeting)
  2. Information request (question about the offer)
  3. Negative reply / opt-out (any refusal)
  4. Out-of-office (automated OOO message)

Unknown or ambiguous replies default to: flag to Doug for manual review.

---

## 1. Positive reply

Definition:
  Any reply expressing interest in a meeting, asking about next steps, or indicating
  openness to a conversation. Ambiguous positive intent should be treated as positive.

Response:
  Send automated reply within the same business hour.
  Include the client's Calendly booking link.
  Use the phrase "grab a slot" — warm, low-friction.
  Signed as: "[Client Company Name] Team"

Identity rules (strict):
  Never use the founder's name — implies they personally wrote this in real time
  Never mention "AI" or "automated" — unnecessary, adds friction
  Never mention "MargenticOS" — clients don't know who we are
  Always use company team name — warm, professional, legally clean, not deceptive
  The agent acts as a competent team member from the client's company

Reply must be:
  - Under 60 words
  - Warm but not gushing
  - One clear call to action (the booking link)
  - Signed as [Company] Team

---

## 2. Information request

Definition:
  Any reply asking a specific question about the offer, pricing, process, or credentials.

Response:
  No automated reply. These require nuanced human judgment.
  Flag to the client immediately as high priority via dashboard notification + email.
  Doug is also notified.

Escalation sequence (if client doesn't respond):
  T+15h:  First reminder to client — "A prospect asked about your offer"
  T+48h:  Second reminder — "Still waiting on your reply to [First Name]"
  T+72h:  Optional holding message sent to prospect (system-generated, warm, buys time)
          Toggle per client, default: off
          Holding message signed by [Company] Team
          Example: "Thanks for your message — [First Name] will get back to you shortly."

Doug can reply directly on the client's behalf via GoHighLevel if needed.

---

## 3. Negative reply / opt-out

Definition:
  Any refusal, hostile language, or unmistakeable indication of no interest.
  One signal is enough — err on the side of suppression.

Covered by:
  Explicit: "stop", "remove me", "unsubscribe", "not interested", "please don't contact me"
  Hostile: "fuck off", "leave me alone", "stop emailing me"
  Any unmistakeable refusal regardless of exact wording

Response:
  Immediately set suppressed = true on the prospect record.
  Push suppression to Instantly API immediately (same call, same transaction).
  Do not wait. Do not queue. Do not send any further messages.
  Log suppression_reason in the prospect record.

Doug is notified of all suppressions (for awareness, no action required from Doug).

---

## 4. Out-of-office

Definition:
  Automated OOO reply detected via pattern matching.
  Common patterns: "I'm out of office", "I'm away", "I'll be back", "out until [date]".

Response:
  Pause the sequence for this prospect in Instantly.
  Extract return date from the OOO message if present.
  Schedule sequence resume for the day after the return date.
  Default if no date found: 10 business days.
  System instructs Instantly to resume via API on the scheduled date.

No reply is sent. The OOO is acknowledged mechanically, not verbally.

---

## Opt-out footer

Required in all outbound emails without exception:

  "Not the right fit? Just reply 'stop' and I'll leave you alone."

Never use the word "unsubscribe" — it sounds like a newsletter, not a human.
This footer is not a legal disclaimer — it is a human sign-off that also serves compliance.

---

## What not to build in phase one

- Fully automated responses to information requests (requires nuanced judgment)
- Sophisticated reply intent classification beyond the four types above
- Multi-turn AI conversations with prospects

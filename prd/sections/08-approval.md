# sections/08-approval.md — Channel Modes, Notification Timing, Batch Sampling
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when working on the approval system.

---

## Overview

The approval system gives clients control over outbound content before it goes live.
Three channels have approval modes. Each channel has different timing and mechanics.

Doug is notified for all rejections and all auto-approvals across all channels.

---

## cold_email — sequence-level approval

What clients approve: the email template and sequence structure.
Not individual personalised emails — the sequence itself.

### Batch sampling (optional, toggled per client)
  - Client can request a sample of 5–10 personalised emails before approving
  - Emails shown with personalisation source tags visible (so client can see what data was used)
  - This is a confidence check, not a per-email review
  - Default: off. Toggle per client in operator settings.

### Auto-approve timing
  Auto-approves after 3 days if no action is taken.

### Notification sequence
  T+0h:   Notification sent — "Sequence ready for review"
  T+15h:  First reminder
  T+48h:  Second reminder
  T-12h:  Final warning before auto-approve (sent 12 hours before the auto-approve fires)

### Rejection
  If client rejects, Doug is notified immediately.
  Campaign does not launch until re-approval.

---

## linkedin_post — toggle mode

What clients approve: individual LinkedIn post content before it's queued for delivery.

### How it works
  - Default: approval ON for all clients
  - Agent generates post content → appears in dashboard approval queue
  - Client reviews and approves in the dashboard
  - Once approved, Doug delivers the content to Taplio queue (manually or via Zapier)
  - Taplio is the publishing layer only — all approval happens in MargenticOS dashboard
  - Taplio has no public API — do not attempt programmatic delivery

### Auto-approve timing
  Auto-approves after 24 hours if no action is taken.

### Toggle
  Clients can switch approval off (all posts auto-approve and go to Taplio immediately).
  Default: approval ON.
  Toggle controlled in client settings in the operator dashboard.

### Rejection
  If client rejects a post, it is archived and Doug is notified.

---

## linkedin_dm — same model as cold_email

What clients approve: the DM template and sequence.
Tool: Lemlist, registered via can_send_linkedin_dm capability.

### Identical mechanics to cold_email:
  - Sequence-level approval (not per-DM)
  - Optional batch sample of personalised DMs
  - 3-day auto-approve
  - Notification sequence: T+0h, T+15h, T+48h, T-12h

---

## Notification delivery

All approval notifications delivered via Resend transactional email.
Notifications go to: the client's registered email + Doug's operator email.

Email copy rules (from design.md):
  Direct, clear, no pressure.
  "2 sequences waiting for your approval — auto-approves in 3 days."
  Never: "Action required immediately" or "URGENT".

---

## Operator notification summary

Doug receives a daily summary of:
  - Pending approvals across all clients
  - Auto-approvals that fired in the last 24 hours
  - Rejections that require follow-up

This daily summary is in addition to real-time notifications for rejections.

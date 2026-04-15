# sections/11-warnings.md — Warning Types, Thresholds, Tiered Response Protocol
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when working on the warnings engine or monitoring.

---

## Tiered response protocol

The warnings engine uses a three-tier response protocol.
Borrowed from SRE practice: green is silent, amber requires human decision, red auto-pauses.

### Green — silent monitoring
  Within acceptable range. No operator action needed.
  No notifications sent. System continues operating normally.

### Amber — diagnostic alert, human decision required
  Outside acceptable range but not critical.
  Diagnostic suggestion sent to Doug with:
    - Plain English explanation of what the data shows
    - Specific recommended action
  No automatic action taken. Doug approves or dismisses.
  Client is not notified.

### Red — auto-pause + critical alert
  Outside critical threshold.
  Automatic action: pause the specific campaign (not all campaigns — scope it precisely).
  Alert sent to Doug with:
    - Plain English diagnosis of what happened
    - Specific recommended fix
    - One-click approve or reject to either apply the fix or override and resume
  Nothing restarts without Doug's explicit action.

### Quality of diagnostics
The quality of the diagnostic matters as much as the threshold.

Good alert:
"Reply rate dropped from 6.8% to 0.4% over 48 hours for Apex Consulting's
finance sequence. A sudden drop (not gradual) typically indicates a deliverability
issue — spam filter or domain blacklist. Recommended: pause and run inbox
placement test in Instantly."

Bad alert (never do this):
"Reply rate is low. Consider reviewing campaigns."

Every alert must include: what changed, over what period, what it likely means,
and one specific recommended action.

---

## Benchmark thresholds

Default thresholds below. All configurable per client in operator settings.

### Reply rate
  Green:  > 5%
  Amber:  3–5% sustained
  Red:    < 3% for 2 consecutive weeks
  Critical: below 1% — immediate deliverability investigation flag

### Positive reply rate
  Flag: if positive replies drop below 40% of total replies
  (i.e. most replies are negative — indicates list quality or offer problem)

### Bounce rate
  Green:  < 1%
  Amber:  1–2%
  Red:    > 2%
  Auto-pause: above 3% (domain health risk)

### Spam complaint rate
  Green:  < 0.1%
  Amber:  0.1–0.3%
  Red:    > 0.3%

### Open rate (directional only — not a primary signal)
  Flag if below 15% sustained for 2 weeks.
  Open rate is unreliable due to Apple Mail Privacy Protection.
  Use as context alongside reply rate — never as a primary performance indicator.

### Meeting quality
  Flag: 3 or more consecutive meetings marked unqualified
  Flag: 2 or more no-shows in the same week

### Document staleness (operator view only)
  Flag: if a strategy document hasn't been meaningfully updated in 60 days
        while campaigns are active for that client.
  This is an internal quality check for Doug. Not shown to clients.
  Prompts Doug to review whether the strategy is still current.

### Document refresh email
  Automated warm email to client every 90 days.
  Framing: "It's been 90 days — anything changed worth updating in your strategy?"
  Clock resets on meaningful intake update.
  Not a warning — a proactive check-in.

---

## Two staleness mechanisms — do not confuse them

1. Internal operator flag (operator view, 60-day trigger):
   Prompts Doug to review the document. Not shown to clients.

2. Client refresh email (90-day trigger via Resend):
   Warm personal email from Doug. Not a system notification.
   "It's been 90 days — anything changed worth updating?"
   Doug receives a copy in his operator notifications when it fires.

These are separate mechanisms with different triggers and different audiences.

---

## Warnings delivery

Amber and red alerts delivered to Doug via:
  - Operator dashboard warnings rail (visible in operator view)
  - Email notification (Resend) for red alerts and critical flags

Clients are never shown raw warning data.
If a campaign pauses due to a red threshold, the client sees:
  "Campaign paused — your team is reviewing performance."
Not the raw metric or the reason.

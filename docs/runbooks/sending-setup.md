# Sending Infrastructure Setup Runbook
# MargenticOS | April 2026
# This is an operator checklist, not a build spec.
# Use this when provisioning sending infrastructure for a new client (including MargenticOS as client zero).
#
# Time required: ~2–3 hours of Doug's active work, spread over a 2–3 week warmup period.
# After setup, the system runs on autopilot until something breaks — then the Deliverability Monitor alerts.

---

## Before you start

Read the client's approved ICP filter spec to understand expected send volume.
Confirm tam_status and tier_3_enabled in the operator settings for this client:
  tier_3_enabled = false (green)  → primary pool only, ~6 mailboxes
  tier_3_enabled = true (amber / red-override)  → primary pool + Tier 3 pool, ~9 mailboxes total

At pessimistic volume (~3,700 sends/month/client), the math per client:
  3,700 sends ÷ 22 business days ÷ 25 sends/mailbox/day ≈ 6–7 mailboxes
  Add 2–3 Tier 3 mailboxes if Tier 3 is enabled.

---

## Part 1 — Domain purchase

For each client:

1. Purchase 2 or 3 dedicated cold-outreach domains.
   DO NOT use the client's primary domain. DO NOT use MargenticOS primary domain.
   Conventions that work:
     [clientbrand]-mail.com
     [clientbrand]-outreach.com
     [clientbrand]hq.com
     try[clientbrand].com
   Keep them readable, not sketchy (no numbers, no hyphens mid-word).

2. Use Namecheap (existing registrar) unless the client prefers another.
   Cost: ~$15/year per domain. Budget 2–3 domains per client.

3. Record each purchased domain in the client's operator settings under
   "Sending domains." These are metadata — MargenticOS does not manage them.

---

## Part 2 — DNS and email authentication

For each domain:

4. In Namecheap DNS settings, configure:

   SPF record (TXT on @):
     v=spf1 include:_spf.google.com include:spf.instantly.email -all
     (adjust the include: part based on mailbox provider — Google Workspace shown here)

   DKIM record (from Google Workspace admin → Apps → Gmail → Authenticate email):
     Google provides the CNAME — paste into DNS as a TXT record under
     google._domainkey

   DMARC record (TXT on _dmarc):
     v=DMARC1; p=none; rua=mailto:doug@margenticos.com; fo=1
     Start permissive (p=none), tighten to p=quarantine only after 2+ weeks of
     clean DMARC reports.

5. After adding DNS records, wait 30–60 minutes for propagation.

6. Verify authentication passes with mxtoolbox.com or dmarcian.com for each domain.
   If any record shows errors, fix before proceeding.

---

## Part 3 — Mailbox creation (Google Workspace)

For each domain, create 2–3 mailboxes:

7. In Google Workspace admin, add the domain as a secondary domain to the
   MargenticOS Workspace account. Verify via DNS record.

8. Create mailboxes under each domain. Naming conventions that work:
     [firstname]@[domain]        (e.g. sarah@clientbrand-mail.com)
     [firstname].[lastname]@[domain]
     Use real-sounding names. Avoid generic aliases (info@, sales@, hello@).
     If using a fictional "team member" name, make sure it's plausible and
     clears any legal concerns (Doug's responsibility).

9. Cost: $6/month per mailbox (Google Workspace Business Starter).
   6 mailboxes × $6 = $36/month per client for Tier 1/2 pool.
   Add 3 × $6 = $18/month if Tier 3 pool required. Total $54/month at most.

10. Configure each mailbox with:
    - A real-looking signature
    - An email forwarding rule (incoming replies forward to doug@margenticos.com
      so everything lands in one inbox while Unibox handles it via Instantly)

---

## Part 4 — Connect to Instantly

For each mailbox:

11. In Instantly workspace for this client, add the mailbox via the "Accounts" tab.
    Authenticate via Google OAuth.

12. Enable warmup on each connected mailbox immediately.
    Set warmup parameters:
      Initial emails per day: 5
      Increment per day: 3
      Target: 40 per day
      Reply rate: 40%
    Let Instantly's network handle warmup traffic automatically.

13. Tag each mailbox with the client name and tier pool:
      "[Client] - Tier 1/2 pool"
      "[Client] - Tier 3 pool" (if applicable)

14. In the client's operator settings in MargenticOS, record the Instantly mailbox
    IDs and the tier assignment. This is metadata for routing — MargenticOS does
    not send via these mailboxes directly, but it needs to know which tier they
    serve for per-tier metric attribution.

---

## Part 5 — Warming period

15. Do nothing with these mailboxes for 2–3 weeks.
    Instantly's warmup network handles the ramp-up. Check the warmup dashboard
    weekly — reputation scores should climb steadily.

16. During warmup:
    - Do NOT send real cold emails from these mailboxes.
    - Do NOT connect them to any campaigns yet.
    - Check deliverability via mail-tester.com once (week 2) to confirm baseline.

17. Flag in the client's operator notes when warmup completes. Update
    send_velocity_per_day in the organisations table based on the total daily
    send capacity across all now-warm mailboxes (conservative: 25 per mailbox).

---

## Part 6 — Activation

18. Once mailboxes are warmed, connect them to the relevant Instantly sequences:
    - Primary pool mailboxes → Tier 1 and Tier 2 campaigns
    - Tier 3 pool mailboxes → Tier 3 campaigns only (NEVER mix)

19. Start campaigns at 50% of steady-state volume for the first week.
    Ramp to full volume over 7–14 days while monitoring Instantly's deliverability
    metrics.

20. Flip the client's sourcing pipeline to active in MargenticOS operator settings.
    The Inventory Monitor will begin triggering sourcing runs based on inventory
    floors. Campaigns will ingest qualified prospects from the sourcing pipeline.

---

## Ongoing — Deliverability monitoring

The Deliverability Monitor (deterministic scheduled job, runs daily) reads
Instantly's per-mailbox metrics and writes warnings to the operator warnings rail
if any of the following fire:

  Bounce rate > 3% over 48 hours             → auto-pause the affected mailbox
  Spam complaint rate > 0.1% over 48 hours   → auto-pause the affected mailbox
  Reply rate drops >50% over 48 hours        → warning (possible deliverability issue)
  Sudden open rate collapse                  → warning

When a warning fires:
  1. Pause the affected mailbox in Instantly.
  2. Run inbox placement test via Instantly's built-in tester.
  3. If deliverability is compromised, do NOT resume until the root cause is
     identified and remediated.
  4. Worst case — if a mailbox is burned — disconnect it from campaigns,
     create a replacement mailbox on the same domain, and re-warm.
     The burned mailbox stays disconnected until 30+ days of cooling off.

---

## Rules that are never broken

- Tier 3 campaigns never send from primary-pool mailboxes.
- A burned mailbox is never re-enabled without a full re-warm cycle.
- Domain purchases never use MargenticOS's own primary domain or the client's
  primary domain.
- SPF/DKIM/DMARC must be verified passing before a mailbox sends any live email.
- Warmup period is non-negotiable. Two weeks minimum. Three is safer.

---

## When to escalate (i.e. to a managed service)

At 10+ clients with 6–9 mailboxes each, sending infrastructure becomes a
meaningful operator task. When that hits:
  - Mailreef — managed warmup and domain rotation
  - Instantly DFY Pre-Warmed Accounts (Instantly's own managed offering)
  - An operator hire to handle sending infrastructure as a dedicated function

This decision is tracked in BACKLOG.md under commercial items.

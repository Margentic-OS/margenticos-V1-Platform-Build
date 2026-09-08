# Suppression — what it is, and how it reaches the sending tool

## What this does

When we decide somebody must not be emailed, two things have to happen:

1. Our database records it, so they are never uploaded to the sending tool again.
2. The sending tool is told, so the emails already queued for them stop.

Step 1 has always worked. **Step 2 did not, on three of the four paths that suppress
somebody**, and this document is mostly about closing that and about the check that says so
when it fails again.

## The failure this was built for

Measured live on 2026-09-04, before any of this existed:

- A prospect was uploaded to the sending tool on 21 August.
- On some later date somebody suppressed them in our database by hand.
- The sending tool never heard about it. It sent them email 3 on 31 August, and email 4 was
  still queued behind a seven-day delay when this was found.
- **Every dashboard and monitor read green the whole time.**

The missing API call was the smaller half. The larger half is that nothing anywhere would
have told you.

## The two suppression stores, and why there are two

| Store | Scope | Written by | Keyed on |
|---|---|---|---|
| `prospects.suppressed` | one prospect, one client | client rejection, research disqualification, opt-out reply, and hand-written UPDATEs | the prospect row, which carries a provider lead id from upload |
| `suppressed_emails` | **global, across all clients** | the bounce and unsubscribe poller | the email address alone, no lead id |

They are not derived from each other and must not be. `prospects.suppressed` carries four
distinct meanings that have nothing to do with deliverability; `suppressed_emails` is a
cross-client do-not-contact list. Both are read together by `findBlockedProspects` in
`src/lib/suppression/send-gate.ts`, which is the one chokepoint deciding who may be sent to.

**Both stores now carry their suppression out to the provider.** Covering only one would
leave half of suppression one-way.

The bounce half looks redundant, because the provider told *us* about the bounce and has
already stopped its own lead. It stops being redundant the moment the same address is a lead
in a second client's campaign in the same shared workspace: that list is global and the
provider's stop was per-lead.

## How the sending tool is told

Everything goes through the **`can_suppress_contact` capability**
(`src/lib/integrations/capabilities/suppress-contact.ts`). No suppression path names a tool.
Swapping the sending tool is a row in `integrations_registry` plus a new handler.

The mechanism is **setting the lead's interest status**, not deleting the lead and not the
blocklist. Both alternatives were considered and refused:

- **Deleting** the lead is documented as irreversible and nothing says what survives it.
  Reply history is load-bearing here: the reply processor threads replies off the stored
  email, analytics counts replies, and the reply audit trail is the record showing an opt-out
  was honoured.
- **The blocklist** is workspace-wide, and one global API key means every client shares one
  workspace. One client rejecting a prospect would block that address out of every other
  client's campaigns, and blocklist entries accept whole domains. Today there is one campaign
  so the blast radius is zero; the moment there are two, it is not.

The cost of refusing the blocklist, stated rather than buried: it is the only mechanism that
can stop an address with no lead row yet. That half is already covered by the send gate,
which blocks a suppressed address before it is ever uploaded.

### The write is read back

`stopLead` writes and then **reads the lead back** before reporting success. A 200 from a
write endpoint is not evidence that the write landed, and this codebase has been burned by
exactly that assumption more than once.

### The stop is asynchronous — measured, not assumed

Proved on a live lead on 2026-09-04:

| when | provider status | interest |
|---|---|---|
| before | 1 Active | unset |
| 0.5 seconds after our write | 1 Active | -1 |
| 43 seconds after | **3 Completed** | -1 |
| after that | gone from the provider's own ACTIVE list | -1 |

So the read-back checks the **interest field** and deliberately says nothing about status.
Requiring status to have moved would fail every suppression this system makes. It is also
why the reconciliation sweep leaves a ten-minute settle window before judging anybody.

## What the prospect row records

Three columns say whether the provider was actually told:

- `outbound_suppression_status` — `not_required` (the provider holds no lead), `confirmed`
  (called and read back), `failed` (call failed, read-back disagreed, or no lead resolvable)
- `outbound_suppression_at`
- `outbound_suppression_error` — only ever set on a `failed` row

**NULL on a suppressed row is a finding, not a gap.** It means something suppressed that
prospect without going through the shared path. Both rows that prompted this build read NULL,
because they were suppressed by a hand-written UPDATE.

## The reconciliation check — MON-026

`/api/cron/suppression-reconcile`, every 30 minutes. **This is the half that matters.**

It reads the **provider's own answer** for every prospect the send gate says must not be
mailed, and reports anyone still being sent to. Expected count: zero.

Three design points worth knowing:

- **It does not read the suppression columns above to decide anything.** A hand-written UPDATE
  leaves them NULL, and using our own columns to audit our own writes is how a check goes
  green over the exact thing it was written to find.
- **It reuses `findBlockedProspects` rather than restating it.** A second definition of "must
  not be mailed" could drift from the first, and a reconciliation that disagrees with the gate
  it audits is worse than none.
- **The stored lead id is a shortcut; the address is the question.** When the stored id does
  not answer, the sweep asks the provider what it holds for the address. The first live run
  reported 2 unreachable and neither was really unreachable: one lead had been deleted with
  its campaign in August, one row carried a *mock* lead id written by an upload made while the
  provider flag was off.

It also asserts an invariant rather than assuming it: **every prospect marked uploaded carries
a provider lead id.** Without one the sweep cannot check them at all, so it must say so rather
than report zero.

### What to check if MON-026 goes red

Read the detail line first. It names the prospects.

| the line says | what it means | what to do |
|---|---|---|
| "still being sent to by the provider" | somebody we suppressed is being emailed right now | stop each one at the provider, then find out how they were suppressed. A hand-written UPDATE is the known cause |
| "marked uploaded with no provider lead id" | the sweep is structurally blind to those rows | find out how they were uploaded without an id; the upload handler marks a prospect `failed` rather than `uploaded` when no lead comes back |
| "could not be read back from the provider" | the provider is unreachable, nobody is necessarily being emailed | usually clears on its own. If it persists, check the API key and the provider's status page |
| "is N minutes old" | the sweep has stopped running | check the `suppression-reconcile` cron job and `cron_heartbeats` |

**Never make it green by editing `suppression_reconciliation_snapshot`.** The next sweep
overwrites it within half an hour with the provider's own answer.

## Stopping one prospect on purpose — the operator's button

Everything above is triggered by something happening **to** us: they replied "stop", their
address bounced, the research agent disqualified them. Until 2026-09-08 there was no way for
a person to simply decide it. Stopping somebody mid-sequence meant opening the sending
vendor's own screen and clicking there, which worked and left no record here of who did it or
why.

**Where:** the operator's sourcing review screen, one "Stop contacting" control per prospect.
A reason is required. There is no way to submit a blank one, because a hold with no reason is
indistinguishable from a bug, and three such rows already exist.

**What one click writes**, in a single statement so the two halves cannot half-land:

| column | why |
|---|---|
| `suppressed`, `suppressed_at`, `suppression_reason` | puts the person inside `findBlockedProspects`, which is **what makes MON-026 able to see them** |
| `send_hold_at`, `send_hold_by`, `send_hold_reason` | makes the decision survive the next re-verification |

Then, and only then, the sending tool is told, through the same capability everything else
uses.

### Why it writes `suppressed` and not just the hold

This is the part worth understanding, because the tidier implementation is wrong.

`send_hold_at` is the purpose-built operator field. It is durable, it survives
re-verification, and on its own it would block the next upload. Nothing obvious breaks.

What it would silently do is leave the prospect **outside** `findBlockedProspects`, and that
predicate is how MON-026 chooses whose provider lead to read back. A hold-only stop would
never be reconciled against the provider, and the monitor would report OK for ever about a
person it could no longer select. The stop would work and the check on it would be blind.

So the `suppressed` write is load-bearing, and there is a live test whose only job is to fail
if somebody removes it.

### Database first, provider second

Always, and the reason is which way it breaks when half of it fails.

| what fails | result |
|---|---|
| the provider call, after the row is written | the row is blocked, MON-026 reads the lead back, sees it still sending, goes **red**. Loud. |
| the database write, after the provider call | the provider is stopped while our record says mailable. Nothing is wrong today and **nothing says anything**. |

Both are failures. Only one of them tells anybody.

### What a failed provider call looks like to the operator

The person is shown as **Stopped**, with a note that the sending tool has not confirmed yet
and that the reconciliation check is watching. That is the truth: the stop is recorded, the
person is blocked, and the sequence may still be running for up to the settle window.

It is deliberately not shown as an error, because an operator told "that failed" retries a
stop that is already correctly recorded.

### Measured: this does not change the client's reply rate

Writing the interest status does **not** perturb the provider's `reply_count`, so
`replyRate` on the client dashboard is unaffected by stopping somebody. Measured 2026-09-08
by reads only: four leads in the live campaign carried the suppression value, only two had
ever replied, and the campaign reported `reply_count` 2, not 4.

The contacted count is likewise untouched: it comes from the provider's
`new_leads_contacted_count`, and stopping somebody does not un-send the emails they already
received. **A stop does not rewrite history**, which is also why it never writes
`client_review_status` — that would remove a contacted person from the client's own record of
who was contacted.

## What this does NOT cover

- **`prospects.email_send_eligible` is untouched.** That verdict is frozen at verification
  time and is a separate problem (see ADR-034). Nothing here re-evaluates it.
- **Suppression is still not retroactive across the board.** Adding a country to
  `EXCLUDED_COUNTRIES` still does not re-evaluate prospects already verified.
- **Addresses with no lead yet** are handled by the send gate at upload, not here.
- **There is no batch stop and no whole-client stop.** One prospect per click, deliberately:
  those cases need a decision about what triggers them before they need code.
- **Archiving a client does not stop their campaign.** The archive route makes no provider
  call at all, and because archived prospects are not blocked, MON-026 does not read them
  back either. Tracked as its own Backlog row, gated Live risk.

## Files

| what | where |
|---|---|
| the shared path both stores use | `src/lib/suppression/provider-suppression.ts` |
| the capability and its resolver | `src/lib/integrations/capabilities/suppress-contact.ts` |
| the provider implementation | `src/lib/integrations/handlers/instantly/suppress-contact.ts` |
| the reconciliation sweep | `src/lib/suppression/reconcile.ts` |
| the cron route | `src/app/api/cron/suppression-reconcile/route.ts` |
| the send gate (who must not be mailed) | `src/lib/suppression/send-gate.ts` |
| the global list | `src/lib/suppression/suppression-list.ts` |
| the operator stop | `src/lib/suppression/stop-prospect.ts` |
| its route | `src/app/api/operator/prospects/stop/route.ts` |
| its control | `src/app/dashboard/operator/sourcing-review/components/StopProspectControl.tsx` |
| the hold columns | `supabase/migrations/20260907193000_prospect_send_hold.sql` |
| columns and capability row | `supabase/migrations/20260904100000_provider_suppression_columns.sql` |
| MON-026 and its cron | `supabase/migrations/20260904110000_mon_026_suppression_reconciliation.sql` |

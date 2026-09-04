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

## What this does NOT cover

- **`prospects.email_send_eligible` is untouched.** That verdict is frozen at verification
  time and is a separate problem (see ADR-034). Nothing here re-evaluates it.
- **Suppression is still not retroactive across the board.** Adding a country to
  `EXCLUDED_COUNTRIES` still does not re-evaluate prospects already verified.
- **Addresses with no lead yet** are handled by the send gate at upload, not here.

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
| columns and capability row | `supabase/migrations/20260904100000_provider_suppression_columns.sql` |
| MON-026 and its cron | `supabase/migrations/20260904110000_mon_026_suppression_reconciliation.sql` |

# Handover: the catch-all second verifier

> **STATUS 2026-08-25: BUILT. This document is now HISTORY, not instructions.**
>
> The build landed in commit 90870a9 (branch `second-pass-verification`). Live technical
> reference: **`docs/email-verification.md`**. Open items: the **Notion Backlog**
> (Company Brain -> Backlog), which is canonical for open work as of 2026-09-04.
> The original "Catch-all second pass" section in `docs/BACKLOG.md` is retained
> there as history.
>
> **Three things in this document turned out to be wrong or incomplete. They are corrected
> here so nobody rebuilds against them.**
>
> 1. **§4 understates the country defect badly.** It says `prospects.country` is unpopulated
>    and would bite at re-verification. The rule could not have fired even with the column
>    populated: the enrichment handler wrote `"Germany"` and the rule matched `'DE'`. And it
>    had ALREADY let two German prospects be mailed. §4's claim that "new prospects are
>    unaffected" is wrong in the direction that matters.
> 2. **A naive backfill would have made it worse.** A populated non-excluded country
>    short-circuits the `.de` domain fallback, so copying `"Germany"` in would have flipped
>    `craid.de` from excluded to ELIGIBLE, turning off the one exclusion that worked.
> 3. **§7's reuse table is good and one row is now void.** The cron shape it points at
>    (`verify-pending`) was still DARK when this was written: MON-019 was registered but never
>    queried, because the sweep looped over two parallel arrays of different lengths. Copying
>    that shape would have copied the blind spot.
>
> The open design question in §5 was answered: second-pass columns plus a paid-call ledger,
> with `email_send_eligible` written by one shared resolver. Leak L7 is closed; L3 is
> deliberately still open. §9's items remain open and are unchanged.


**Written 2026-08-25 for a fresh session.** Everything the next session needs, and nothing it
does not. The session that wrote this was carrying two days of cost analysis that is
irrelevant to the build; that context has been deliberately left out.

Scope: **3–4 build-days across ~13 files, gated behind a half-day paid sample.**
Do the sample first. If it comes back negative, the build is dead and you have lost half a day.

---

## 1. What the prize actually is

**8 prospects with finished, paid-for personalisation copy that cannot be mailed.**

Live client-zero organisation `0ed34697-0fa9-4f08-ac15-d3504ac45caf`, 28 unsuppressed:

| Bucket | n | Notes |
|---|---|---|
| Catch All, approved, pending, **has copy** | **8** | the prize |
| Catch All, approved, pending, no copy | 1 | needs research spend first |
| Catch All, **rejected** by client | 1 | never claimed for upload. Not recoverable |
| Invalid / Unknown | 2 | unmailable under any policy |
| Valid, country-excluded (DE) | 1 | commercial rule, not a verification question |
| Valid, approved, **already uploaded** | 14 | already mailed |
| Valid, review status never set | 1 | blocked on review, not verification |

Verify it yourself before trusting it:

```sql
SELECT independent_email_status, client_review_status, outbound_upload_status,
       count(*), count(*) FILTER (WHERE personalisation_trigger IS NOT NULL) AS has_copy
FROM prospects
WHERE organisation_id='0ed34697-0fa9-4f08-ac15-d3504ac45caf' AND suppressed=false
GROUP BY 1,2,3 ORDER BY 1;
```

**The research money on these 8 is already spent.** Every one of the 28 has been researched
and there are ZERO unresearched prospects left, so a second verifier buys mailable prospects
at no incremental research cost. Good ratio, small absolute number. That is why the sample
gates the build.

## 2. All ten catch-all domains are on Microsoft or Google

Bouncer's specific claim is deep verification of catch-alls hosted by **Google and
Microsoft** — provider-specific, not general. Measured by MX lookup on 2026-08-25:

| Host | n | Domains |
|---|---|---|
| Microsoft 365 | 5 | akiriconsulting.com, mpcconsulting.com, olympus.com, soleconsulting.co, thesouthstarconsulting.com |
| Google Workspace | 5 | beranekconsulting.com, cruzconsultinggroup.com, esstrategic.co, landmarksurf.com, northernstarconsult.com |
| Niche / other | **0** | — |

**10 of 10 sit inside the stated capability.** Small consulting firms are overwhelmingly on
Workspace or M365, and this cohort is unanimous. Reproduce with
`dig +short MX <domain>` over the ten.

### THE SAMPLE HAS BEEN RUN. 2026-08-25. 8 of 10 recovered.

All ten addresses were put through Bouncer's real-time endpoint on the free tier. Nothing was
written to the database.

| address | Bouncer | reason | acceptAll | provider | score | claimable? |
|---|---|---|---|---|---|---|
| emily@esstrategic.co | DELIVERABLE | accepted_email | yes | google | 90 | **yes** |
| hkim@mpcconsulting.com | DELIVERABLE | accepted_email | yes | outlook | 90 | **yes** |
| jan@beranekconsulting.com | DELIVERABLE | accepted_email | yes | google | 90 | **yes** |
| jay.soon@soleconsulting.co | DELIVERABLE | accepted_email | yes | outlook | 90 | **yes** |
| kelli@cruzconsultinggroup.com | DELIVERABLE | accepted_email | yes | google | 90 | **yes** |
| lmulberry@northernstarconsult.com | DELIVERABLE | accepted_email | yes | google | 90 | **yes** |
| kgentic@akiriconsulting.com | DELIVERABLE | accepted_email | yes | outlook | 90 | no copy yet |
| charlie.setzler@landmarksurf.com | DELIVERABLE | accepted_email | yes | google | 90 | client REJECTED |
| sohail@thesouthstarconsulting.com | RISKY | low_deliverability | yes | outlook | 75 | no |
| tatyana.chorny@olympus.com | RISKY | low_deliverability | yes | outlook | 15 | no |

**RECOVERY RATE 8/10 = 80%. Commercially claimable right now: 6.** One recovered address is
client-rejected and one has no copy written yet.

Every MyEmailVerifier verdict here was "Catch All", and Bouncer returned
`domain.acceptAll: yes` on all ten — it AGREES the domains are catch-all and still resolved
eight addresses individually. That is the provider-specific claim doing exactly what it says.
Provider detection matched an independent MX lookup exactly, 5 google and 5 outlook.

**How much to trust 8/10.** It is a strong signal and not a coin flip, but it is one cohort of
ten on one day, and the 95% interval on 8/10 runs roughly 44-97%. Every domain was on Google
or Microsoft, which is precisely Bouncer's stated sweet spot, so treat this as close to a BEST
case rather than a general rate. The two risky addresses count as NOT recovered: risky is
where we started.

One oddity worth a look before sourcing more: olympus.com scored 15, far below every other
address, and is a large corporate domain rather than a small consulting firm. It may be a
mis-sourced prospect.

Pricing, confirmed from the vendor page: **$8 per 1,000 pay-as-you-go, credits never expire,
no prepaid block minimum.** The earlier "unsourced / expect a block minimum" warning in this
document was wrong and is withdrawn. Ten checks would have cost 8 cents; the free tier covered
it.

The throwaway script that produced this is NOT in the repository, deliberately. It was a
one-off measurement, not the integration.

---

That was the strongest argument for the sample. It is NOT evidence the vendor will resolve
them in general: catch-all is a property of the receiving DOMAIN, which answers yes to every address by
design, so an SMTP-probing vendor gets the same answer. Recovery comes from provider APIs and
heuristics. **There is no measured catch-all recovery rate anywhere in this repo.** Any
number you have seen is a ceiling, not a forecast.

## 3. Why the percentage cap makes catch-alls unsendable at current volume

Best practice caps accept-all addresses at roughly **2–5% of a campaign**. Accept-all
addresses bounce roughly **27x more often** than verified-valid ones (Hunter). So this is
risk management, not verification.

Run the arithmetic against the live pool:

| | |
|---|---|
| Catch-alls with copy | 8 |
| Batch size needed to send them at a 5% cap | **160 prospects** |
| At a 2% cap | **400 prospects** |
| Send-eligible prospects available today | **15**, of which 14 already uploaded |

**At this volume the cap makes the catch-all bucket effectively unsendable.** The only route
to using those 8 is a second verifier resolving them OUT of the bucket — at which point they
are Valid and uncapped.

That is the whole business case. The second verifier is not a cost optimisation. It is the
only unlock, and everything else about catch-alls is deferred until volume exists.

## 4. HARD PREREQUISITE: country must be populated first

**Do not run the second pass until `prospects.country` is populated for the live 28.**

`prospects.country` is **0 of 28** populated. `verification-trigger.ts:129` selects that
column and passes `prospect.country` into `checkSendEligibility` at `:298`, so the country
exclusion evaluates against null and cannot fire. The one prospect currently flagged
`country_excluded_de` was flagged by a manual script on 2026-08-10, not by this path.

**It bites exactly at re-verification, which is precisely what the second pass does.** A
German catch-all re-verified as Valid comes back send-eligible with the country rule never
consulted. The DE exclusion is a commercial rule, not a preference.

New prospects are unaffected: `adapter-apollo-enrichment.ts:659` writes `country` on every
new enrichment. The exposure is the existing 28 only.

Related and already decided: **the Apollo backfill was measured and declined** — 28 credits
to save at most 4 live `people/match` calls, a net loss of ~24, because 23 of 28 hold a
`personalisation_trigger` and the trigger guard refuses to re-research them. See
`docs/BACKLOG.md`. Populating `country` is a different and much smaller job than that
backfill; do not conflate them.

## 5. Two-step pattern, not a vendor swap

**Do NOT replace MyEmailVerifier with Bouncer.** The documented pattern is two-step:

1. Cheap verifier across the whole list — MyEmailVerifier, already wired.
2. Resolution-capable tool on the **catch-all and unknown segment only**.

MyEmailVerifier is not inaccurate. It is being honest: detection of a catch-all signals
**risk**, not safety, and no vendor can verify one with confidence by probing.

`prospects.verification_provider` **already exists** as a column and is the right shape for
recording which vendor produced a verdict. Note its column DEFAULT currently contains the
literal string `'myemailverifier'` — a vendor name in a column default, which is the hardest
kind to remove because existing rows carry it.

**Open design question for the next session:** how are TWO verdicts represented? Today there
is one `independent_email_status`. Options are overwrite, add columns, or a separate
`verification_results` table. Whichever you pick, decide the **disagreement rule** explicitly
— MEV says Catch All, second vendor says Valid, which wins? — and note that the answer may
legitimately differ for research eligibility versus send eligibility, because those read
different things (see §6).

## 6. Seven places vendor vocabulary has leaked into shared code

The capability-registry rule (CLAUDE.md) says a handler owns its vendor's translation and
nothing upstream sees vendor-specific names. That rule is broken in seven places. **Six are
on code paths nothing calls, so they cost only on the day you add a second vendor. One is
live.**

| # | Leak | Where | Live? |
|---|---|---|---|
| L1 | Shared result type hardcodes MEV's five verdict words | `adapter-myemailverifier.ts:14-25` | no |
| L2 | Send/no-send policy computed inside the vendor handler | `adapter-myemailverifier.ts:76` | no |
| L3 | Trigger imports the vendor handler by name, no capability lookup | `verification-trigger.ts:17,208` | no |
| L4 | Literal `'myemailverifier'` written to the database, and in the column DEFAULT | `verification-trigger.ts:308` | no |
| L5 | The string `'Grey-listed'` embedded in a database filter | `verification-trigger.ts:133` | no |
| L6 | Vendor rate limit and free-tier cap as constants in shared code | `verification-trigger.ts:21-24` | no |
| **L7** | **Vendor verdict words inside the research spend gate** | **`send-eligibility-policy.ts`** | **YES** |

**L7 is the one that costs today** and it was introduced on 2026-08-25 by the session that
wrote this handover. `UNDELIVERABLE_STATUSES` and the `'Catch All'` comparison are MEV's
vocabulary sitting in a shared policy module. Fix it when you add the second vendor, not
before — it is only wrong once two vocabularies exist.

**Do not try to fix this by routing through the capability registry.**
`src/lib/handlers/capability.ts` has an empty handler map and zero callers, all 14
`integrations_registry` rows read `connection_status='disconnected'`, and the handler
signature does not match the map. Every other integration bypasses it the same way. Closing
that gap is a deliberate repo-wide change, not a rider on this one.

**One rule to preserve.** `CATCH_ALL_IS_RESEARCH_WORTHY` (is this worth researching?) and
`adapter-myemailverifier.ts:76` (is this safe to mail?) answer **different questions** and are
documented as independently changeable. The first reads the RAW verdict so policy can change
against data already bought; the second is MATERIALISED into `email_send_eligible` at
verification time, so changing it needs a paid re-verification run. Normalising them into one
flag silently re-couples research spend to send policy.

## 7. What was built on 2026-08-25 that you should REUSE, not copy

The verification wiring shipped in `1f12a2f` and `088957d`. **The second verifier is a
near-copy of the verification trigger, so building it before reading these copies four fixed
bugs back into a new file.**

| Reuse this | Where | Why it matters to you |
|---|---|---|
| **Lock lifecycle** | `verification-trigger.ts` — `releaseVerificationLock`, the `heldLocks` set, the stale reclaim in the selection | The lock used to be set before work and cleared ONLY on success. Any crash stranded the batch permanently. Your second pass locks the same rows |
| **Attempt counting on failure** | same file, the catch block | The stale reclaim without this is worse than the bug it fixed: a permanently bad address gets re-probed forever. `MAX_RETRY_ATTEMPTS` only binds if failures count |
| **Probe timeout** | `adapter-myemailverifier.ts` — `VERIFY_FETCH_TIMEOUT_MS`, 20s | Verification is an SMTP probe behind HTTP and hangs as long as the far end holds the socket. Your vendor needs the same |
| **Batch sized against the clock** | `DEFAULT_VERIFY_BATCH_SIZE = 40` | The loop sleeps 2s per address, so N addresses cost 2(N-1)s before any network time. The old default of 100 could not finish inside its own route |
| **`maxDuration = 300`** | both the operator route and `api/cron/verify-pending` | The operator route declared nothing. Any long route in this repo needs it |
| **Account-wide quota, UTC boundary, fail-closed on unreadable count** | `verification-trigger.ts` step 1 | The quota is per ACCOUNT, not per organisation. If your vendor is paid, this is where its budget check belongs |
| **The cron shape** | `src/app/api/cron/verify-pending/route.ts` | Bearer `CRON_SECRET`, service role, Sentry check-in, one organisation per invocation, `organisations!inner(archived_at)` so archived orgs are never served |
| **Migration that never touches the secret** | `supabase/migrations/20260825210000_verify_pending_pg_cron.sql` | Copies the authorised command from the `queue-worker` job and rewrites only the URL path. The repo is PUBLIC; never put `CRON_SECRET` in a migration |
| **Test fake for the trigger** | `src/lib/sourcing/__tests__/verification-trigger-safety.test.ts` | A fake Supabase client that records update payloads per id. Three of the four bugs are about which WRITES happen on which path, and only this shape catches them |

**Known residual, already stated in the code:** a probe that consumed quota and then failed
leaves no timestamped record, so cross-run failure accounting is approximate. Fixing it needs
a call-counter table. If your second vendor is PAID per address, that table stops being
optional — a paid call you cannot count is a budget you cannot enforce.

## 8. Sequence

1. **Populate `country` for the live 28** — hard prerequisite, §4.
2. **Half-day paid sample.** Buy the smallest credit block, run the 10 catch-all addresses
   through a throwaway script modelled on `scripts/run-mev.ts`, write the answers down.
   **DONE 2026-08-25 — see §2. 8 of 10 recovered, 6 claimable.** Pricing confirmed at $8 per
   1,000 pay-as-you-go with no block minimum and non-expiring credits, so the block-pricing
   warning this document originally carried is withdrawn.
3. **Decide.** The sample came back 80% recovered, 6 immediately claimable. Doug's call.
4. **Build**, reusing §7 rather than copying it.

## 9. Accepted for the record, not yet built

- `CATCH_ALL_IS_RESEARCH_WORTHY` to be **renamed** — it decides SPEND, not usability, and the
  current name implies the latter.
- The percentage becomes a **send-side quota**. `actions.ts:322-331` claims the batch as a
  bulk `UPDATE...WHERE`, which cannot express "at most N% of this batch"; it needs
  restructuring to select → compose → claim-by-id first.
- The live catch-all test needs an **absolute-count trigger**, a **denominator floor**, and
  **cohort tagging**. 25 sends across 10 mailboxes means one bounce on a denominator of 2
  reads as 50%, and CLAUDE.md's percentage thresholds would fire on noise.
- **There is no auto-pause anywhere in the code**, despite CLAUDE.md describing one. That stop
  is not optional scope if the live test runs.

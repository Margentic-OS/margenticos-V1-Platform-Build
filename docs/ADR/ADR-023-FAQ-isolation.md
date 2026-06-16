# ADR-023 — FAQ answer content isolation and dormancy verification

**Date:** 2026-06-16  
**Status:** Accepted  
**Supersedes:** None  
**Related:** ADR-003 (agent isolation), ADR-019 (reply handling tier model), ADR-018 (deterministic vs LLM)

---

## Context

The FAQ system (Phase 2 Group 2+) extracts question/answer pairs from operator-sent Tier 3 replies, and will generate baseline FAQs from organisation intake and strategy documents. Both sources write to the `faq_extractions` table for operator curation before approval.

The critical requirement: FAQ answer content must be strictly scoped to a single organisation. An answer extracted from Org A's reply can only ever surface in draft context for Org A. There is no path — matcher, drafter, extraction, or approval — by which one organisation's FAQ answer content reaches another organisation.

This is a confidentiality boundary (ADR-003: "A data leak between clients is the most serious possible error"). The database and application layers must enforce it together.

---

## Decision

### Part A: Database-enforced read isolation

RLS policies are present on both `faqs` and `faq_extractions` tables (verified live 2026-06-16):

| Table | Policy | Target Role | Rule |
|-------|--------|-------------|------|
| faqs | clients_cannot_access_faqs | authenticated | USING false (blocks all) |
| faqs | operators_full_access_faqs | authenticated, is_operator()=true | USING is_operator(), WITH CHECK is_operator() |
| faq_extractions | clients_cannot_access_faq_extractions | authenticated | USING false (blocks all) |
| faq_extractions | operators_full_access_faq_extractions | authenticated, is_operator()=true | USING is_operator(), WITH CHECK is_operator() |

**Guarantee:** Clients cannot read FAQ tables (RLS blocks all rows via clients_cannot_access policies). Operators can read only if is_operator() returns true (RLS gate).

**Limitation:** Service role bypasses RLS by design. Backend writes to faqs/faq_extractions use service role and are NOT protected by RLS. Application code must ensure organisation_id is correct before write.

### Part B: Application-enforced write isolation

Every code path that inserts FAQ data includes organisation_id as a required parameter and validates FK references before write:

1. **Extraction agent (faq-extraction-agent.ts, lines 74-353)**
   - Lines 74-83: Pre-flight validation on organisationId (UUID format check)
   - Lines 102-109: Idempotency check scoped to organisation_id
   - Lines 290-296: FAQ matcher called with organisationId filter
   - Lines 312-326: Defensive cross-org check on similar_faq_id — verifies returned FAQ belongs to the requesting org. Throws CRITICAL error if mismatch.
   - Lines 336-353: Same defensive check for similar_pending_extraction_id

2. **Send path (send-approved-draft.ts, lines 309-348)**
   - Line 166: Signal context query scoped to organisation_id
   - Line 298: Extraction agent invoked with organisationId as required parameter
   - Lines 310-328: Before writing extracted FAQ to faq_extractions, validate FK references belong to the organisation (added 2026-06-16)
   - Line 311+ (post-hardening): Ownership validation on similar_faq_id and similar_pending_extraction_id before write

3. **FAQ matcher (matcher.ts, lines 19-114)**
   - Lines 40-44: Approved FAQs query includes .eq('organisation_id', organisationId)
   - Lines 84-88: Pending extractions query includes .eq('organisation_id', organisationId)
   - Deterministic code (no LLM), no cross-org branching

**Guarantee:** Every query that reads org context or writes FAQ data filters by organisation_id at the application layer. RLS acts as a safety net for any bugs in application filtering.

### Part C: Dormancy verification

**Inbound prospect contact:** Disabled  
- Instantly polling is dormant: `instantly_api_active` is_active=false in integrations_registry
- The pg_cron job for polling exists but getInstantlyApiActive() returns false, so no real replies are fetched

**Outbound prospect contact:** Requires explicit operator action  
- Sending via sendThreadReply requires an approved draft (status='approved') created by the reply-draft-agent
- Draft creation requires operator approval of a tier-3 draft via /api/reply-drafts/[id]/approve
- No automated sending is possible without operator action
- FAQ extraction is post-send (best-effort, non-blocking), so it cannot trigger prospect contact

**Apollo enrichment:** Dormant  
- `apollo_api_active` is_active=false in integrations_registry
- Prospect research agent and sourcing pipeline cannot call Apollo

**Conclusion:** No inbound or outbound prospect contact is possible without explicit operator action (reply approval). FAQ system is safe to build during dormancy period.

### Part D: Threat model (honest assessment)

**Where isolation is DATABASE-ENFORCED (RLS hardened):**
- Authenticated client reads faqs/faq_extractions: Blocked by RLS clients_cannot_access policies (USING false). Database guarantees zero rows returned.
- Operator reads: Protected by is_operator() RLS gate. If an operator's auth role is false, RLS blocks all rows.

**Where isolation is APPLICATION-ENFORCED ONLY (RLS cannot protect):**
- Service-role writes to faqs/faq_extractions: RLS is bypassed. Application code must ensure every insert includes correct organisation_id.
- Queries that load org context (ICP, positioning, TOV): If .eq('organisation_id') filter is removed, wrong org's documents could be loaded and passed to agents. RLS does NOT protect because service role bypasses it.

**Queries at risk if .eq('organisation_id') filter is removed:**
- send-approved-draft.ts:117-121 (org load), 162-167 (signal load)
- loadOrgContext.ts (ICP/positioning/TOV loads)
- findFaqMatches() matcher.ts:40-44, 84-88 (FAQ queries)
- extractFaq() agent:102-109, 312-316, 336-340 (context and validation)

**Hardening applied (2026-06-16):**
- Added ownership validation before writing FAQ extractions to faq_extractions (send-approved-draft.ts)
- Defensive checks in extraction agent already validated FK references belong to org
- Added `source` column to faq_extractions to distinguish seed_generated from reply_extracted
- Added index on (organisation_id, status, source) for curation filtering

---

## Reasoning

**Why three-level enforcement (RLS + app filters + defensive checks)?**

Service role bypasses RLS by design — there is no database-only solution to protect service-role writes. Application code is the primary gate. RLS is a safety net for:
1. Bugs in application filtering (if .eq() is forgotten or broken)
2. Future code paths that might query faqs/faq_extractions with a different role

**Why faq_extractions, not faqs, for seed-generated FAQs?**

Seed FAQs are speculative (generated from strategy docs, not validated against real replies). Requiring operator curation before approval ensures consistent quality gate for all FAQ sources (both seed-generated and reply-extracted).

**Why isolated at org level, not client-visible?**

Cross-organisation pattern learning (identifying common questions across clients) is explicitly out of scope per the task brief. Each organisation's FAQ knowledge base is independent. Cross-org learning may use anonymized structural patterns in a future phase, but never answer content.

---

## Rejected Alternatives

- **Full RLS protection for service-role writes:** Impossible by design. Service role bypasses RLS. Rejected as infeasible.
- **Application-only isolation (no RLS):** Rejected because RLS is a necessary safety net. Without it, a single forgotten .eq() filter could leak data across orgs.
- **Client-visible FAQ sharing:** Rejected per ADR-003 (multi-tenant isolation at three levels). Cross-org learning is deferred and explicitly bounded.

---

## Consequences

1. **For Phase B FAQ seed agent build:**
   - Seed agent receives organisationId as required parameter
   - All document reads in the caller are scoped by organisation_id before passing to agent
   - Seed FAQs insert to faq_extractions with source='seed_generated' and status='pending'
   - Operator curates seed FAQs same as reply-extracted ones

2. **For ongoing development:**
   - Every new query against faqs or faq_extractions must include .eq('organisation_id', organisationId) explicitly
   - Every insert must include organisation_id with the correct value
   - Defensive FK checks (similar to faq-extraction-agent) are required for any cross-table references
   - RLS policies must not be removed or weakened

3. **For testing:**
   - Unit tests verify application-layer .eq() filtering works (matcher test)
   - Integration tests verify RLS blocks cross-org authenticated reads (requires JWT auth flow, deferred)
   - Application-layer filtering is the primary gate; RLS is verified to exist but secondary

4. **Documentation:**
   - This ADR explicitly states what is database-enforced vs application-enforced
   - CLAUDE.md agent isolation rules (ADR-003) remain unchanged
   - Code comments in send-approved-draft.ts and matcher.ts reference this ADR

---

## Verification (2026-06-16)

**ISO-1: Live RLS policies confirmed to exist**
```sql
SELECT tablename, policyname, cmd, roles, qual, with_check 
FROM pg_policies 
WHERE tablename IN ('faqs','faq_extractions') 
ORDER BY tablename, policyname;
```
Result: All four policies (clients_cannot_access_faqs, operators_full_access_faqs, clients_cannot_access_faq_extractions, operators_full_access_faq_extractions) exist and are correctly configured.

**ISO-2: Threat model stated explicitly**
- Service-role writes bypass RLS (application-enforced only)
- Authenticated reads are RLS-protected (database-enforced)
- Operator reads require is_operator() gate (database-enforced)

**ISO-3: Hardening applied**
- Ownership validation added to send-approved-draft.ts before faq_extractions inserts
- Defensive checks already present in faq-extraction-agent.ts
- source column added to faq_extractions for curation filtering

**ISO-4: Dormancy verified**
- `instantly_api_active` is_active=false (inbound polling dormant)
- No automatic outbound sending (requires operator draft approval)
- Apollo enrichment dormant (apollo_api_active is_active=false)
- FAQ system safe to build and test during dormancy period

---

## Follow-up (post-Phase B)

Once Phase 2 Group 4+ FAQ seed and curation builds are complete:
1. Verify seed agent generates FAQs only for target organisation
2. Verify seed FAQs land in faq_extractions with source='seed_generated'
3. Confirm operator curation UI filters by source and displays both types correctly
4. Run end-to-end: seed → pending extraction → operator approval → faqs table → matcher uses approved FAQs

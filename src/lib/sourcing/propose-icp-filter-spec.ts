import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  deriveFilterSpec,
  REVENUE_NOT_OPTED_IN_LEAD,
  type ICPFilterSpec,
  type OmittableAxis,
  type SpecGeography,
  type SpecSeniority,
} from '@/lib/agents/icp-filter-spec'
import { inspectFilterSpec } from '@/lib/sourcing/inspect-filter-spec'
import { deriveBuyerCriterionWithVocabulary } from '@/agents/buyer-criterion-agent'
import { deriveFitDimensions } from '@/agents/fit-dimensions-agent'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'
import type { FitDimensionSet } from '@/lib/agents/research/fit-dimensions'
import { evaluateBuyerCriterion, type BuyerCriterion } from '@/lib/sourcing/buyer-criterion'
import { resolveIcpGeography } from '@/lib/sourcing/resolve-icp-geography'
import {
  BUYER_PROFILE_COLUMNS,
  BUYER_PROFILE_TABLE,
  rowToBuyerProfile,
} from '@/lib/intake/buyer-profile-store'
import { statedHeadcount } from '@/lib/intake/buyer-profile-authority'
import {
  compareTargetingInputs,
  readStoredTargetingInputs,
  targetingInputs,
  type TargetingChange,
  type TargetingInputs,
} from '@/lib/sourcing/targeting-inputs'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { buildSpecRefusal } from '@/lib/sourcing/spec-refusal'

// What happens to a client's search settings when their ICP, or one of the two inputs
// outside it, changes. ADR-061.
//
// ─── WHAT THIS REPLACED ──────────────────────────────────────────────────────
//
// `persistIcpFilterSpec` ran after every ICP promotion. It made three model calls, wrote
// the result straight over the live settings, and re-queued every removed prospect. It
// never asked whether the edit had touched targeting. On 2026-09-30 an edit to two trigger
// reasons added a job title and a seniority band to one client's search, turned that
// client's buyer criterion off, and removed 62 prospects five minutes later.
//
// ─── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────
//
// The new ICP version already carries the live settings: the promote function copied them
// onto it. This function then asks ONE question, of one list:
//
//     are the targeting fields the same ones the live settings were built from?
//
//   SAME       nothing runs. No model is called and nothing is written. The search, the
//              cursor and every tiering verdict stay exactly as they were.
//   DIFFERENT  a proposal is built and stored BESIDE the live settings, in
//              icp_filter_spec_proposed. The live settings are not touched. Nothing is
//              re-queued. The operator approves or rejects it (ADR-061 steps 5 and 6).
//
// ─── ONLY THE PARTS WHOSE INPUTS CHANGED ARE REBUILT ─────────────────────────
//
//   deterministic parse   always. It is free and it cannot drift.
//   geography             a model call, only when a geography field changed.
//   buyer criterion       a model call, only when a buyer profile or a disqualifier changed.
//   fit dimensions        a model call, only when a targeting field in the document changed.
//
// Everything else is carried over from the live settings VERBATIM, field by field, after
// the derivation has run. So a headcount edit proposes a headcount change and nothing else
// in the search. That is not a nicety. A buyer criterion re-derived on identical input
// moved a quarter of its fragments (measured 2026-09-08), and a proposal that re-derived
// everything would bury the one change the operator made under changes nobody made.
//
// ─── THE FLOOR THIS APPLIES ──────────────────────────────────────────────────
//
// A re-derived criterion that does not gate is not proposed when a gating one is live. The
// live criterion is kept, with its titles and seniority, and the proposal records why
// (`criterion_held`), so the panel can say so. Doug's decision of 2026-09-30.
//
// ─── FAILURES LEAVE THE LIVE SETTINGS IN FORCE ───────────────────────────────
//
// Every failure below ends the same way: no proposal, live settings unchanged, an error in
// the log and in Sentry. That is the whole of the change in failure behaviour. Before, a
// failed geography left the settings NULL and stopped sourcing; a failed criterion was
// described as storing settings without titles and in fact stored nothing, under a log line
// that blamed the industries. Now a client whose targeting edit could not be turned into a
// proposal keeps running on what was approved, and somebody is told.
//
// Never throws.

/** What one call did. Returned for the tests and for the log; no caller branches on it. */
export type ProposalOutcome =
  /** Not an ICP, not found, or no longer the active version. Nothing to do. */
  | { outcome: 'skipped'; why: 'not_found' | 'not_icp' | 'not_active' }
  /** The targeting fields match the live settings. Nothing ran, nothing was written. */
  | { outcome: 'unchanged' }
  /** They match again, and a proposal from an earlier edit was pending. It was cleared. */
  | { outcome: 'proposal_cleared' }
  /** They differ, and a pending proposal already covers exactly these fields. */
  | { outcome: 'already_proposed' }
  /** A proposal was built and stored. `rebuilt` names the model calls that ran. */
  | {
      outcome: 'proposed'
      change: TargetingChange
      rebuilt: { geography: boolean; buyer_criterion: boolean; fit_dimensions: boolean }
      criterion_held: boolean
    }
  /** It could not be built. The live settings are unchanged. */
  | { outcome: 'failed'; step: string; error: string }

type StoredSpec = ICPFilterSpec | null

function fail(
  step: string,
  err: unknown,
  context: Record<string, unknown>,
): ProposalOutcome {
  const error = err instanceof Error ? err.message : String(err)
  logger.error(`proposeIcpFilterSpec: ${step} failed, no proposal filed`, {
    ...context,
    error,
    consequence:
      'The live search settings are unchanged and stay in force. The ICP says something the ' +
      'search does not yet reflect, and nothing is pending for the operator to approve. ' +
      'Saving the ICP again, or scripts/propose-icp-filter-spec.ts, retries it.',
  })
  Sentry.withScope(scope => {
    scope.setTag('component', 'proposeIcpFilterSpec')
    scope.setTag('step', step)
    for (const [key, value] of Object.entries(context)) scope.setExtra(key, value)
    Sentry.captureException(err instanceof Error ? err : new Error(error))
  })
  return { outcome: 'failed', step, error }
}

/** The gate's own answer to "does this criterion apply". Not a second copy of the rule. */
function gates(criterion: BuyerCriterion | null | undefined): boolean {
  return evaluateBuyerCriterion(criterion, 'x').decision !== 'no_criterion'
}

/**
 * The seniority parameter the live settings were built with, as far as it can be recovered.
 *
 * `omitted_axes` on stored settings mixes two sources: axes the derivation switched off,
 * and `company_revenue` switched off by the opt-in rule. deriveFilterSpec re-applies the
 * opt-in rule itself, so that one is taken back out here when the rule is what put it
 * there, which its recorded reason says. Left in, a client who has since been opted in
 * would be reported as having had the band switched off by the derivation.
 *
 * ACCEPTED LOSS: where the derivation ALSO proposed switching the revenue band off, that
 * second opinion was recorded only inside the reason text and is not recovered. It changes
 * a sentence in the notes and never the search: the operator's switch decides either way.
 */
function carriedSeniority(live: ICPFilterSpec): SpecSeniority {
  const reasons = { ...(live.omission_reasons ?? {}) }
  // Matched on the stable lead, not the whole sentence: settings written before the
  // sentence was reworded still carry the old wording after it.
  const byOptInRule = (reasons.company_revenue ?? '').startsWith(REVENUE_NOT_OPTED_IN_LEAD)
  const omitted = (live.omitted_axes ?? []).filter(
    axis => !(axis === 'company_revenue' && byOptInRule),
  ) as OmittableAxis[]
  if (byOptInRule) delete reasons.company_revenue
  return {
    bands: [...live.seniority_levels],
    discarded: [],
    evidence: '',
    omitted,
    omittedReasons: reasons,
  }
}

/**
 * The geography the live settings were built with.
 *
 * ACCEPTED LOSS: which countries the legal subtraction removed, and which phrases named no
 * country, were written into the live settings' notes as prose and are not recovered. A
 * proposal that carries geography over therefore has notes without those two sentences. The
 * countries themselves are carried exactly, and the subtraction is re-applied by the
 * handler on every request whatever the notes say.
 */
function carriedGeography(live: ICPFilterSpec): SpecGeography {
  return { countries: [...live.company_countries], removed_by_exclusion: [], unresolved_phrases: [] }
}

/**
 * The targeting fields as they stand NOW: the document's, plus the two inputs outside it.
 *
 * ONE READER. The proposal below and the operator scripts both ask "what are this client's
 * targeting fields today", and two readers of the revenue switch and the intake headcount
 * would be two answers to that.
 *
 * A FAILED READ IS RETURNED AS A FAILURE, NEVER AS A GUESS. The old path guessed: an
 * unreadable switch was treated as off, an unreadable headcount as unanswered. That was
 * safe when the result was only ever a derivation. Here the result is a COMPARISON, and a
 * guessed value would differ from the stored one and file a proposal to switch something
 * off that nobody touched. Not knowing is a reason to do nothing, loudly.
 */
export async function readCurrentTargetingInputs(
  supabase: SupabaseClient,
  organisationId: string,
  icpContent: unknown,
): Promise<{ inputs: TargetingInputs } | { step: string; error: string }> {
  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('sourcing_revenue_filter_enabled')
    .eq('id', organisationId)
    .single()
  if (orgError || !org) {
    return { step: 'read the revenue switch', error: orgError?.message ?? 'organisation not found' }
  }

  // READ HERE, with its error, and not through readBuyerProfile. That helper drops the
  // error and returns an empty profile, which for a save form is a reasonable "treat it as
  // a first answer". For this comparison it is the guess described above: a read that
  // failed would look like a client who has withdrawn their headcount.
  const { data: profileRow, error: profileError } = await supabase
    .from(BUYER_PROFILE_TABLE)
    .select(BUYER_PROFILE_COLUMNS)
    .eq('organisation_id', organisationId)
    .maybeSingle()
  if (profileError) return { step: 'read the intake headcount', error: profileError.message }

  // No row is a real answer: this client has not been asked, or has not answered.
  const stated = statedHeadcount(rowToBuyerProfile(profileRow as Record<string, unknown> | null))
  return {
    inputs: targetingInputs(icpContent, {
      statedHeadcount: stated,
      revenueFilterEnabled: org.sourcing_revenue_filter_enabled === true,
    }),
  }
}

/**
 * The settings these targeting fields produce when every MODEL-derived part is carried
 * over from the live settings. No model is called.
 *
 * What the stamping script uses to ask an honest question before it marks a client's
 * settings approved: do the live settings actually match what this client's targeting
 * fields produce today? Where they do not, a stored snapshot would claim a match that does
 * not exist, and the difference would never be proposed.
 */
export function rederiveCarryingModelParts(live: ICPFilterSpec, inputs: TargetingInputs): ICPFilterSpec {
  const spec = deriveFilterSpec(
    inputs.document, live.buyer_criterion ?? null, carriedGeography(live), carriedSeniority(live),
    { revenueFilterEnabled: inputs.revenue_filter_enabled, statedHeadcount: inputs.stated_headcount },
  )
  spec.person_countries = live.person_countries
  spec.company_countries = live.company_countries
  spec.job_titles = live.job_titles
  spec.job_titles_excluded = live.job_titles_excluded
  spec.seniority_levels = live.seniority_levels
  if (live.buyer_criterion) spec.buyer_criterion = live.buyer_criterion
  if (live.fit_dimensions) spec.fit_dimensions = live.fit_dimensions
  spec.targeting_inputs = inputs
  return spec
}

/**
 * Compare the active ICP's targeting fields with the live settings, and file a proposal
 * when they differ.
 *
 * Called after every promotion (approve, revise, revert, and the paused auto-approve job),
 * and through proposeIcpFilterSpecForOrganisationSafely when the intake headcount or the
 * revenue switch is saved.
 */
export async function proposeIcpFilterSpec(
  supabase: SupabaseClient,
  documentId: string,
): Promise<ProposalOutcome> {
  const outcome = await runProposal(supabase, documentId)
  await recordProposalOutcomeOnDocument(documentId, outcome)
  return outcome
}

/**
 * Write the outcome onto the document, so the operator's ICP page says when the search settings
 * do not reflect this version. Before this, a failed proposal reached Sentry and nowhere the
 * operator looks: the ICP read as finished while the search kept its old settings (F2a, 5 Oct
 * 2026). A later success clears the mark.
 *
 * A skipped outcome means the document was not the active ICP, so there is nothing to say about
 * it and nothing is written. NEVER THROWS: the caller's answer is already decided.
 */
async function recordProposalOutcomeOnDocument(
  documentId: string,
  outcome: ProposalOutcome,
): Promise<void> {
  if (outcome.outcome === 'skipped') return
  try {
    const service = await createServiceRoleClient()
    const refusal =
      outcome.outcome === 'failed'
        ? buildSpecRefusal('proposal_failed', `${outcome.step}: ${outcome.error}`)
        : null
    const { error } = await service
      .from('strategy_documents')
      .update({ icp_filter_spec_refusal: refusal })
      .eq('id', documentId)
    if (error) throw new Error(error.message)
  } catch (err) {
    logger.error('proposeIcpFilterSpec: could not record the outcome on the document', {
      document_id: documentId,
      outcome: outcome.outcome,
      error: err instanceof Error ? err.message : String(err),
    })
    Sentry.withScope(scope => {
      scope.setTag('component', 'proposeIcpFilterSpec')
      scope.setTag('step', 'record the outcome on the document')
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)))
    })
  }
}

async function runProposal(
  supabase: SupabaseClient,
  documentId: string,
): Promise<ProposalOutcome> {
  const context: Record<string, unknown> = { document_id: documentId }

  try {
    // ── 1. The document, with the settings the promote function copied onto it ──
    const { data: doc, error: docError } = await supabase
      .from('strategy_documents')
      .select('id, document_type, status, content, organisation_id, icp_filter_spec, icp_filter_spec_proposed')
      .eq('id', documentId)
      // maybeSingle, not single: a missing row is an empty answer, not an error, so the only
      // error this read can return is a failure of the read itself.
      .maybeSingle()

    // A read that FAILED is not "not found". Reporting it as a skip, at warn, is how a transient
    // gateway cut on this read used to leave a promoted ICP with no proposal and no trace (F2a).
    if (docError) return fail('read the document', docError.message, context)
    if (!doc) {
      logger.warn('proposeIcpFilterSpec: document not found', { ...context, error: 'no row' })
      return { outcome: 'skipped', why: 'not_found' }
    }
    if (doc.document_type !== 'icp') return { outcome: 'skipped', why: 'not_icp' }
    if (doc.status !== 'active') {
      // A second promotion landed while this one was waiting. The newer call owns the
      // comparison, and a proposal written here would sit on an archived row nobody reads.
      logger.info('proposeIcpFilterSpec: document is no longer the active version, skipping', context)
      return { outcome: 'skipped', why: 'not_active' }
    }
    context.organisation_id = doc.organisation_id

    // ── 2. The targeting fields as they stand now ────────────────────────────
    const read = await readCurrentTargetingInputs(supabase, doc.organisation_id, doc.content)
    if ('error' in read) return fail(read.step, read.error, context)
    const current: TargetingInputs = read.inputs

    // ── 3. The one question ──────────────────────────────────────────────────
    const live = (doc.icp_filter_spec ?? null) as StoredSpec
    const pending = (doc.icp_filter_spec_proposed ?? null) as StoredSpec
    const change = compareTargetingInputs(
      live ? readStoredTargetingInputs(live.targeting_inputs) : null,
      current,
    )

    if (live && !change.changed) {
      if (pending === null) {
        logger.info('proposeIcpFilterSpec: no targeting field changed, settings stand', context)
        return { outcome: 'unchanged' }
      }
      // The document was edited back to what the live settings were built from. The
      // pending proposal describes a change that is no longer being asked for.
      const { error: clearError } = await supabase
        .from('strategy_documents')
        .update({ icp_filter_spec_proposed: null })
        .eq('id', documentId)
        .eq('status', 'active')
      if (clearError) return fail('clear a superseded proposal', clearError.message, context)
      logger.info('proposeIcpFilterSpec: targeting fields match the live settings again, pending proposal cleared', context)
      return { outcome: 'proposal_cleared' }
    }

    // A pending proposal already built from exactly these fields. This is what keeps a
    // run of prose edits, made while a proposal waits, from calling a model each time.
    if (pending) {
      const against = compareTargetingInputs(readStoredTargetingInputs(pending.targeting_inputs), current)
      if (!against.changed) {
        logger.info('proposeIcpFilterSpec: a pending proposal already covers these targeting fields', context)
        return { outcome: 'already_proposed' }
      }
    }

    // ── 4. Rebuild only what changed ─────────────────────────────────────────
    const rebuildGeography = !live || change.geography
    const rebuildCriterion = !live || change.buyer
    const rebuildFit = !live || change.document

    // Buyer criterion and seniority: one call, two answers, when it runs at all.
    let criterion: BuyerCriterion | null = live?.buyer_criterion ?? null
    let seniority: SpecSeniority = live ? carriedSeniority(live) : { bands: [], discarded: [], evidence: '' }
    let criterionHeld: ICPFilterSpec['criterion_held'] | undefined
    let keepLiveBuyerFields = Boolean(live) && !rebuildCriterion

    if (rebuildCriterion) {
      let derived: Awaited<ReturnType<typeof deriveBuyerCriterionWithVocabulary>>
      try {
        derived = await deriveBuyerCriterionWithVocabulary({
          supabase,
          organisation_id: doc.organisation_id,
        })
      } catch (err) {
        return fail('derive the buyer criterion', err, context)
      }

      if (derived.seniority.discarded.length > 0) {
        logger.warn('proposeIcpFilterSpec: seniority values the provider would not honour', {
          ...context,
          discarded_count: derived.seniority.discarded.length,
          kept_count: derived.seniority.bands.length,
        })
      }

      if (!gates(derived.criterion) && live && gates(live.buyer_criterion)) {
        // THE FLOOR. The buyer criterion stays applied. What came back is recorded and
        // the whole answer of that call is set aside, seniority included: half of one
        // call's answer beside half of another's is settings nobody derived.
        criterionHeld = {
          rederived_status: derived.criterion.status,
          reason: derived.criterion.unsettled_reason ?? derived.criterion.sanity?.note ?? null,
          held_at: new Date().toISOString(),
        }
        keepLiveBuyerFields = true
        logger.warn('proposeIcpFilterSpec: re-derived criterion does not gate, live criterion kept', {
          ...context, ...criterionHeld,
        })
      } else {
        criterion = derived.criterion
        seniority = derived.seniority
        if (!gates(criterion)) {
          logger.warn('proposeIcpFilterSpec: proposed criterion does not gate and none is live', {
            ...context,
            status: criterion.status,
            consequence:
              'This proposal cannot be approved as it stands: a criterion that does not gate ' +
              'never becomes live. The client is not sourced until the documents settle who ' +
              'the buyer is.',
          })
        }
      }
    }

    // Geography and fit dimensions side by side, as before: each is bounded, and in
    // sequence they would not fit the route's budget beside the criterion call.
    const fitPending: Promise<{ set: FitDimensionSet | null; error: string | null }> = rebuildFit
      ? deriveFitDimensions({ doc: doc.content as IcpDocument })
          .then(set => ({ set, error: null }))
          .catch(err => ({ set: null, error: err instanceof Error ? err.message : String(err) }))
      : Promise.resolve({ set: live?.fit_dimensions ?? null, error: null })

    let geography: SpecGeography
    if (rebuildGeography) {
      try {
        geography = await resolveIcpGeography({ supabase, doc: current.document })
      } catch (err) {
        await fitPending
        return fail('resolve the geography', err, context)
      }
    } else {
      geography = carriedGeography(live!)
    }

    let spec: ICPFilterSpec
    try {
      spec = deriveFilterSpec(current.document, criterion, geography, seniority, {
        revenueFilterEnabled: current.revenue_filter_enabled,
        statedHeadcount: current.stated_headcount,
      })
    } catch (err) {
      await fitPending
      return fail('derive the settings from the targeting fields', err, context)
    }

    if (criterion) spec.buyer_criterion = criterion

    const fit = await fitPending
    if (fit.set) {
      spec.fit_dimensions = fit.set
    } else if (fit.error) {
      // Fails open, as it always has: the search does not read the dimensions. The live
      // set is carried so the judge keeps grading as it does today.
      if (live?.fit_dimensions) spec.fit_dimensions = live.fit_dimensions
      logger.error('proposeIcpFilterSpec: fit dimensions could not be derived', {
        ...context,
        error: fit.error,
        consequence: live?.fit_dimensions
          ? 'The proposal carries the live fit dimensions unchanged.'
          : 'The proposal carries no fit dimensions; the research judge gives its own grade.',
      })
    }

    // ── 5. Carry over, verbatim, everything whose inputs did not change ───────
    //
    // AFTER the derivation, and by assignment. deriveFilterSpec was handed the carried
    // values and should have reproduced them, and this does not rely on that: the
    // promise is that an untouched part of the settings is byte-for-byte the live one.
    if (live) {
      if (!rebuildGeography) {
        spec.person_countries = live.person_countries
        spec.company_countries = live.company_countries
      }
      if (keepLiveBuyerFields) {
        spec.job_titles = live.job_titles
        spec.job_titles_excluded = live.job_titles_excluded
        spec.seniority_levels = live.seniority_levels
        if (live.buyer_criterion) spec.buyer_criterion = live.buyer_criterion
        else delete spec.buyer_criterion
      }
      if (!rebuildFit) {
        if (live.fit_dimensions) spec.fit_dimensions = live.fit_dimensions
        else delete spec.fit_dimensions
      }
    }
    if (criterionHeld) spec.criterion_held = criterionHeld
    spec.targeting_inputs = current

    const findings = inspectFilterSpec(spec)
    if (findings.length > 0) {
      logger.warn('proposeIcpFilterSpec: proposed settings have findings', {
        ...context, finding_count: findings.length, findings,
      })
    }

    // ── 6. Store it BESIDE the live settings ─────────────────────────────────
    const { data: written, error: writeError } = await supabase
      .from('strategy_documents')
      .update({ icp_filter_spec_proposed: spec })
      .eq('id', documentId)
      .eq('status', 'active')
      .select('id')
    if (writeError) return fail('store the proposal', writeError.message, context)
    if (!written || written.length === 0) {
      // The row stopped being active between the read and the write. Nothing was stored,
      // and the promotion that archived it runs this function itself.
      logger.info('proposeIcpFilterSpec: document was archived before the proposal was stored', context)
      return { outcome: 'skipped', why: 'not_active' }
    }

    const rebuilt = {
      geography: rebuildGeography,
      buyer_criterion: rebuildCriterion,
      fit_dimensions: rebuildFit,
    }
    // At warn, because it is a thing somebody has to act on: the ICP and the search now
    // disagree, on purpose, until an operator approves or rejects.
    logger.warn('proposeIcpFilterSpec: targeting changed, proposal filed for approval', {
      ...context,
      first_settings: !live,
      changed_paths: change.paths,
      inputs_unknown_before: change.unknown_before,
      rebuilt,
      criterion_held: Boolean(criterionHeld),
      consequence:
        'The live search settings are unchanged. Sourcing, tiering and the buyer gate keep ' +
        'using them until the proposal is approved.',
    })
    return { outcome: 'proposed', change, rebuilt, criterion_held: Boolean(criterionHeld) }
  } catch (err) {
    return fail('an unexpected step', err, context)
  } finally {
    try {
      await Sentry.flush(2000)
    } catch {}
  }
}

/**
 * The same comparison, for a change made OUTSIDE the document: the intake headcount, or
 * the revenue switch. Finds the organisation's active ICP and builds its own service-role
 * client, so no caller can hand it a session client that RLS would silently refuse.
 *
 * NEVER THROWS. The answer the caller was saving is already saved.
 */
export async function proposeIcpFilterSpecForOrganisationSafely(
  organisationId: string,
): Promise<ProposalOutcome | null> {
  try {
    const service = await createServiceRoleClient()
    const { data: doc, error } = await service
      .from('strategy_documents')
      .select('id')
      .eq('organisation_id', organisationId)
      .eq('document_type', 'icp')
      .eq('status', 'active')
      .maybeSingle()
    if (error) {
      logger.error('proposeIcpFilterSpecForOrganisationSafely: could not find the active ICP', {
        organisation_id: organisationId, error: error.message,
      })
      return null
    }
    // No ICP yet. The first approval will file the first proposal.
    if (!doc) return null
    return await proposeIcpFilterSpec(service, doc.id)
  } catch (err) {
    logger.error('proposeIcpFilterSpecForOrganisationSafely: threw', {
      organisation_id: organisationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// The weekly watch: the shapes, and the one rule that matters.
//
// THE RULE: A SOURCE THAT COULD NOT BE READ MUST NEVER RENDER AS A NUMBER.
//
// Every figure on this report exists to answer "is it safe to advance a ramp step".
// A zero is the most reassuring answer any of them can give: zero spam, zero bounces,
// zero inactive accounts. So a failed read that defaults to zero does not merely lose
// information, it manufactures the exact reading an operator is hoping for and advances
// a ramp on the strength of it.
//
// That is why there is no default anywhere in this module and no `number` field that can
// hold a "we don't know". A source returns Reading<T>: either an 'ok' carrying a value,
// or an 'unknown' carrying the reason it could not be read. There is no third case and
// no fallback.
//
// This is the same shape CLAUDE.md keeps relearning: the monitor sweep whose loop never
// reached MON-019 and read as healthy; the audit query that could not see a view and
// returned zero rows reassuringly for months. In both, the check answered and the answer
// meant nothing. Here the check is required to say so.

import type { SendingHealthVerdict } from '@/lib/sending-health/evaluate'

/**
 * A value that was read, or a stated reason it could not be.
 *
 * Deliberately has no `value` on the unknown branch, so there is nothing for a caller to
 * reach for by accident. `r.value` does not typecheck until `r.status === 'ok'` has been
 * narrowed, which makes the distinction impossible to skip rather than merely impolite.
 */
export type Reading<T> =
  | { readonly status: 'ok';      readonly value: T }
  | { readonly status: 'unknown'; readonly reason: string }

export function ok<T>(value: T): Reading<T> {
  return { status: 'ok', value }
}

/**
 * `reason` is mandatory and free text, because "unknown" on its own sends the reader to
 * go and find out what broke. The reason is what turns the report into an instruction.
 */
export function unknown<T>(reason: string): Reading<T> {
  return { status: 'unknown', reason }
}

// ── The six values ───────────────────────────────────────────────────────────

/** One mailbox's warmup placement. The canary: warmup lands in spam before prospect mail does. */
export interface WarmupMailbox {
  mailbox:     string
  sent:        number
  landedInbox: number
  landedSpam:  number
  healthScore: number | null
}

export interface WarmupCanary {
  mailboxes:       WarmupMailbox[]
  totalLandedSpam: number
  /** Mailboxes we asked about and got nothing back for. Never silently dropped. */
  missing:         string[]
}

export interface BounceWindow {
  verdict: SendingHealthVerdict
  /** Newest fetched_at in the table. A stale table is not a quiet one. */
  freshestFetch: string
}

export interface AccountStatus {
  mailbox:      string
  active:       boolean
  warmupActive: boolean
}

export interface AccountStatuses {
  /** Taken from the campaign's own sender list, so "all 10" tracks the world, not a constant. */
  expected: string[]
  accounts: AccountStatus[]
  inactive: string[]
  /** Senders on the campaign that the provider's account list did not return at all. */
  missing:  string[]
}

export interface RampPosition {
  dailyLimit:       number
  mailboxCount:     number
  domainCount:      number
  perMailboxPerDay: number
  perDomainPerWeek: number
  /** 1-based rung on the ladder, or null when the limit is not a rung (someone set it by hand). */
  rung:             number | null
  ladderLength:     number
  nextRung:         number | null
}

export interface LeadCapacity {
  planId:          string
  limit:           number
  used:            number
  remaining:       number
  /** null when no uploads were observed in the lookback: no burn is not zero burn. */
  burnPerWeek:     number | null
  weeksRemaining:  number | null
}

export interface Inventory {
  pending:          number
  burnPerWeek:      number | null
  weeksOfInventory: number | null
}

/**
 * The six sources, as a type. Adding a seventh here makes the report literal in
 * collect.ts a COMPILE ERROR until it is filled in, which is the notification that a new
 * source needs collecting.
 *
 * Do not satisfy that error with `as`. The cast would switch off precisely the check that
 * is doing the work, which is the type-assertion trap in CLAUDE.md.
 */
export interface WatchValues {
  warmupCanary: WarmupCanary
  bounces:      BounceWindow
  accounts:     AccountStatuses
  ramp:         RampPosition
  leadCapacity: LeadCapacity
  inventory:    Inventory
}

export type WatchSource = keyof WatchValues

/** Every source, each independently readable or not. */
export type WatchReadings = { [K in WatchSource]: Reading<WatchValues[K]> }

export interface WeeklyWatchReport {
  generatedAt: string
  readings:    WatchReadings
}

/**
 * ADVANCE is the only verdict that permits a ramp step.
 *
 * INCOMPLETE and HOLD both mean do not advance. They are kept apart because they need
 * different actions: HOLD means the numbers say wait, INCOMPLETE means we do not have
 * the numbers. Collapsing them would let a broken reader look like a cautious one.
 */
export type Verdict = 'ADVANCE' | 'HOLD' | 'INCOMPLETE'

// ── The provider seam ────────────────────────────────────────────────────────

/**
 * Everything the watch needs from whichever tool is sending the email.
 *
 * The collectors depend on THIS, never on a vendor. Endpoint paths, auth headers,
 * pagination quirks and field names live behind it in the integrations layer, so swapping
 * the sending tool is a new implementation of this interface plus a registry row
 * (ADR-001). Nothing in src/lib/weekly-watch/ names a vendor.
 *
 * Every method THROWS on failure rather than returning a Reading. Turning a failure into
 * a stated reason is the collector's job, and keeping it there means there is exactly one
 * place where that translation happens.
 */
export interface WatchProvider {
  /** Warmup placement per mailbox, keyed by mailbox. Absent key = provider returned nothing. */
  fetchWarmupPlacement(mailboxes: string[]): Promise<Map<string, ProviderWarmup>>
  /** Every sending account the workspace knows about, keyed by lowercased address. */
  fetchAccountStatuses(): Promise<Map<string, ProviderAccount>>
  /** The campaign's daily limit and sender list. */
  fetchCampaignShape(externalId: string): Promise<{ dailyLimit: number; senders: string[] }>
  /** The workspace's plan identifier, used to guard the pinned lead limit. */
  fetchPlanId(): Promise<string>
  /** Lead counts per campaign, summed by the caller. */
  fetchCampaignLeadCounts(): Promise<number[]>
}

export interface ProviderWarmup {
  sent:        number
  landedInbox: number
  landedSpam:  number
  healthScore: number | null
}

export interface ProviderAccount {
  active:       boolean
  warmupActive: boolean
}

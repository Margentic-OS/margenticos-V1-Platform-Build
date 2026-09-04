// Which sourcing handler is active, in ONE place.
//
// The dispatch map below used to be an object literal inside the orchestrator. It is
// hoisted here because a second caller now needs the same answer: the ICP filter spec
// derivation has to ask the active handler which countries it can target before it writes
// a country into a spec. Two dispatch maps kept in step by hand is the parallel-array
// shape CLAUDE.md warns about, and the drift would be silent in the worst direction: a
// handler registered in one map and not the other would derive specs it cannot source.
//
// This module is allowed to name a tool. It is the seam where a capability becomes a
// concrete handler, which is exactly what the integrations registry pattern puts here.
// Nothing upstream of it names one.

import type { SupabaseClient } from '@supabase/supabase-js'
import { apolloHandler } from '@/lib/sourcing/handlers/adapter-apollo'
import type { SourcingHandler } from '@/lib/sourcing/types'

// ─── The manifest half of the interface, checked without a cast ──────────────
//
// `apolloHandler as SourcingHandler` is how this was written, and the cast is doing real
// damage rather than none: a handler missing a required manifest field would compile
// silently, which is precisely what SourcingHandler's required fields exist to prevent.
// CLAUDE.md's rule about `as` on an object literal applies exactly here.
//
// The cast cannot simply be deleted, because `adapter` and `execute` are declared as
// `(spec: unknown) => unknown` and a handler narrows its own parameter, which is not
// assignable. That is a real variance problem and not the thing worth checking.
//
// So the DATA fields are checked with `satisfies`, which verifies presence and shape
// without widening, and the cast is left to do only the variance work it was needed for.
// Adding a required manifest field to SourcingHandler is now a compile error at every
// handler that lacks it.
type HandlerManifest = Pick<
  SourcingHandler,
  'name' | 'supported_fields' | 'targeted_industries' | 'targetable_countries'
>

const _apolloManifestIsComplete = apolloHandler satisfies HandlerManifest
void _apolloManifestIsComplete

/** Registry tool_name -> handler implementation. */
export const HANDLER_DISPATCH: Record<string, SourcingHandler> = {
  apollo: apolloHandler as unknown as SourcingHandler,
}

/**
 * The handler currently registered for can_source_prospects.
 *
 * THROWS when there is none, or when the registered tool has no implementation. Both are
 * conditions under which sourcing cannot run at all, so a caller that needs to know what
 * the handler can do has no meaningful answer to fall back on.
 */
export async function resolveActiveSourcingHandler(
  supabase: SupabaseClient,
): Promise<SourcingHandler> {
  const { data, error } = await supabase
    .from('integrations_registry')
    .select('tool_name')
    .eq('capability', 'can_source_prospects')
    .eq('is_active', true)
    .single()

  if (error || !data) {
    throw new Error(
      'No active handler is registered for can_source_prospects, so there is nothing ' +
      'that can say which countries are reachable. Enable a sourcing handler in ' +
      `integrations_registry.${error ? ` (${error.message})` : ''}`,
    )
  }

  const handler = HANDLER_DISPATCH[data.tool_name]
  if (!handler) {
    throw new Error(
      `The registry names '${data.tool_name}' for can_source_prospects but no handler ` +
      'implementation is registered for it in HANDLER_DISPATCH.',
    )
  }

  return handler
}

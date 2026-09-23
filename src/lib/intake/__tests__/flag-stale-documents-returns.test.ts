// What flagDocumentsStaleForIntakeEdit REPORTS BACK, which is new and is load-bearing.
//
// The operator notification names the documents that are now possibly out of date. The only
// thing that knows which those are is this function: it reads the live rows first, so it can
// tell a document it just flagged from one that was already stale, from one that does not
// exist for this organisation. A caller recomputing the list from documentsAffectedBy()
// would be a SECOND answer to one question and would name documents nobody flagged.
//
// The cross-organisation and privilege behaviour is covered live in
// flag-stale-documents.live.test.ts. This file is about the return value only, so it uses a
// fake and runs in the unit tier.

import { describe, it, expect } from 'vitest'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { flagDocumentsStaleForIntakeEdit } from '../flag-stale-documents'

const ORG = 'org-1'

/**
 * A fake that honours the filters this function applies.
 *
 * It THROWS on an unimplemented call rather than returning a chainable that swallows it. A
 * fake that silently accepts a filter it does not implement cannot test that filter, and
 * this one has to model a real sequencing detail: the read happens BEFORE the update, and
 * the update must not return rows the read did not see.
 */
function fakeService(liveDocs: { id: string; document_type: string }[], opts: {
  updateCount?: number | null
  readError?: string
  updateError?: string
} = {}) {
  const updates: Record<string, unknown>[] = []
  const remaining = [...liveDocs]

  const service = {
    from(table: string) {
      if (table !== 'strategy_documents') throw new Error(`fake: unexpected table ${table}`)
      let selecting = false
      let updatePayload: Record<string, unknown> | null = null
      let types: string[] = []

      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => { selecting = true; return chain },
        update: (payload: Record<string, unknown>) => { updatePayload = payload; return chain },
        eq: () => chain,
        in: (_col: string, values: string[]) => { types = values; return chain },
        is: () => {
          // Terminal. Resolves as a thenable, which is how PostgREST chains behave.
          const matched = remaining.filter(d => types.includes(d.document_type))
          if (selecting) {
            if (opts.readError) return Promise.resolve({ data: null, error: { message: opts.readError } })
            return Promise.resolve({ data: matched, error: null })
          }
          if (opts.updateError) return Promise.resolve({ error: { message: opts.updateError }, count: null })
          const count = opts.updateCount === undefined ? matched.length : opts.updateCount
          if ((count ?? 0) > 0) {
            updates.push(updatePayload as Record<string, unknown>)
            // Flagged rows stop being live, which is what `.is('is_stale', false)` means.
            for (const d of matched) {
              const i = remaining.findIndex(r => r.id === d.id)
              if (i >= 0) remaining.splice(i, 1)
            }
          }
          return Promise.resolve({ error: null, count })
        },
      })
      return chain
    },
  }

  return { service: service as unknown as ServiceRoleClient, updates }
}

describe('it reports what it actually flagged', () => {
  it('names a document it moved from live to stale', async () => {
    // company_what_you_do feeds the ICP.
    const { service } = fakeService([{ id: 'd1', document_type: 'icp' }])
    const flagged = await flagDocumentsStaleForIntakeEdit(service, ORG, ['company_what_you_do'])
    expect(flagged).toEqual(['icp'])
  })

  it('reports NOTHING when the document was already stale', async () => {
    // An empty live set is the common case and is not a fault. Reporting 'icp' here would
    // tell the operator this edit invalidated something when it changed no row at all.
    const { service } = fakeService([])
    const flagged = await flagDocumentsStaleForIntakeEdit(service, ORG, ['company_what_you_do'])
    expect(flagged).toEqual([])
  })

  it('reports nothing for an answer that feeds no document', async () => {
    // company_currency is in NOT_MAPPED: a display unit that changes no argument.
    const { service } = fakeService([{ id: 'd1', document_type: 'icp' }])
    const flagged = await flagDocumentsStaleForIntakeEdit(service, ORG, ['company_currency'])
    expect(flagged).toEqual([])
  })

  it('reports nothing when the write was refused, rather than claiming a flag', async () => {
    // A zero-row update against a non-empty read is what a silently refused write looks
    // like. Reporting it as flagged would put a document in an operator email that is still
    // live, which is the worst direction for this to be wrong in.
    const { service } = fakeService([{ id: 'd1', document_type: 'icp' }], { updateCount: 0 })
    const flagged = await flagDocumentsStaleForIntakeEdit(service, ORG, ['company_what_you_do'])
    expect(flagged).toEqual([])
  })

  it('reports nothing when the read failed', async () => {
    const { service } = fakeService([{ id: 'd1', document_type: 'icp' }], { readError: 'boom' })
    expect(await flagDocumentsStaleForIntakeEdit(service, ORG, ['company_what_you_do'])).toEqual([])
  })

  it('reports nothing when the update errored', async () => {
    const { service } = fakeService([{ id: 'd1', document_type: 'icp' }], { updateError: 'boom' })
    expect(await flagDocumentsStaleForIntakeEdit(service, ORG, ['company_what_you_do'])).toEqual([])
  })

  it('does not report the same document twice when two answers feed it', async () => {
    // Both of these feed the ICP. The second field finds nothing live, because the first
    // already flagged it, and that is correct behaviour rather than a refusal.
    const { service } = fakeService([{ id: 'd1', document_type: 'icp' }])
    const flagged = await flagDocumentsStaleForIntakeEdit(
      service, ORG, ['company_what_you_do', 'clients_clone'],
    )
    expect(flagged).toEqual(['icp'])
  })

  it('still writes the stale reason, which the return value must not have replaced', async () => {
    // Guard the guard: proves the fake reached the UPDATE at all, so an empty return above
    // means "nothing was flagged" rather than "nothing ever ran".
    const { service, updates } = fakeService([{ id: 'd1', document_type: 'icp' }])
    await flagDocumentsStaleForIntakeEdit(service, ORG, ['company_what_you_do'])
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ is_stale: true })
    expect(String(updates[0].stale_reason)).toContain('company_what_you_do')
  })
})

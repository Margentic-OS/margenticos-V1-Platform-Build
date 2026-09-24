import { describe, it, expect } from 'vitest'
import { buildVariantGenerationContext } from '@/agents/messaging-generation-agent'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * ignore_existing_document must stop the live messaging document being READ, not merely
 * stop it being used. Asserting the returned value is null would pass just as happily
 * against a version that fetched the document and then dropped it, and "the model was not
 * shown it" is a claim about what was sent, which starts at whether it was read at all.
 *
 * The fake records every filter it is given and THROWS on anything it does not implement,
 * rather than returning a chainable that silently swallows it. A fake that accepts calls
 * it does not honour cannot test the thing those calls decide.
 */
function recordingClient(): { client: SupabaseClient; reads: string[] } {
  const reads: string[] = []
  const doc = (document_type: string) => ({
    id: `${document_type}-1`, document_type, version: '1', status: 'active',
    plain_text: `${document_type} text`, content: { a: 1 }, created_at: '2026-01-01',
  })
  const make = (table: string) => {
    const filters: string[] = []
    const record = () => { reads.push(`${table}[${filters.join(',')}]`) }
    const listData = () => {
      if (table === 'intake_responses') return [{ field_key: 'company_name', field_label: 'Company', response_value: 'x', section: 'company', is_critical: true }]
      if (table === 'strategy_documents') return ['icp', 'positioning', 'tov'].map(doc)
      return []
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters.push(`${col}=${String(val)}`); return chain },
      in: (col: string, vals: unknown) => { filters.push(`${col}in${JSON.stringify(vals)}`); return chain },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => { record(); return { data: null, error: null } },
      single: async () => {
        record()
        if (table === 'organisations') return { data: { id: 'org-1', name: 'Org', founder_first_name: 'Sam' }, error: null }
        if (table === 'strategy_documents') return { data: doc('messaging'), error: null }
        return { data: null, error: { message: 'none' } }
      },
      then: (resolve: (v: unknown) => unknown) => {
        record()
        return Promise.resolve({ data: listData(), error: null }).then(resolve)
      },
    }
    return new Proxy(chain, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        throw new Error(`fake supabase does not implement .${prop}() on ${table}`)
      },
    })
  }
  return { client: { from: (t: string) => make(t) } as unknown as SupabaseClient, reads }
}

const messagingRead = (r: string) => r.startsWith('strategy_documents[') && r.includes('document_type=messaging')

describe('cold generation does not read the live messaging document', () => {
  it('reads it by default', async () => {
    const { client, reads } = recordingClient()
    await buildVariantGenerationContext(client, 'org-1', undefined, []).catch(() => {})
    expect(reads.some(messagingRead), `reads were: ${reads.join(' | ')}`).toBe(true)
  })

  it('does not read it when the caller asks for a cold generation', async () => {
    const { client, reads } = recordingClient()
    await buildVariantGenerationContext(client, 'org-1', undefined, [], true).catch(() => {})
    expect(reads.filter(messagingRead), `reads were: ${reads.join(' | ')}`).toEqual([])
  })
})

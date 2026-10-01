// ADR-061 step 3, against the real function in the TEST database.
//
// The unit test beside this file reads the migration. This one runs it. A migration can say
// one thing while the database holds another, and only calling the function shows which.
//
// Every organisation here is created by this file and deleted by this file, by id.
// The settings are placeholder objects: the function copies jsonb and never reads inside it,
// so nothing here needs to look like a real client's search.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'

const CONTEXT = 'promote-inherits-settings.live.test.ts'

let service: SupabaseClient<Database>
let untyped: SupabaseClient
const created: string[] = []

const LIVE_SETTINGS = { marker: 'live settings', list: ['a', 'b'], nested: { n: 1 } }
const PROPOSAL = { marker: 'a pending proposal' }
const APPROVED_AT = '2026-01-02T03:04:05.000Z'

async function seedOrganisation(label: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await service
    .from('organisations')
    .insert({ name: `${label} ${stamp}`, slug: `${label}-${stamp}` })
    .select('id')
    .single()
  expect(error).toBeNull()
  created.push(data!.id)
  return data!.id
}

async function seedActiveDocument(
  organisationId: string,
  documentType: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await untyped
    .from('strategy_documents')
    .insert({
      organisation_id: organisationId,
      document_type: documentType,
      status: 'active',
      version: '1',
      content: { words: `first ${documentType}` },
      ...extra,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function promote(organisationId: string, documentType: string, content: unknown) {
  const { data, error } = await untyped.rpc('promote_strategy_doc_version', {
    p_org_id: organisationId,
    p_doc_type: documentType,
    p_segment_id: null,
    p_content: content,
    p_update_trigger: 'client_revision',
  })
  expect(error).toBeNull()
  return data as { id: string; version: string }
}

async function readSettings(documentId: string) {
  const { data, error } = await untyped
    .from('strategy_documents')
    .select('status, version, content, icp_filter_spec, icp_filter_spec_proposed, icp_filter_spec_approved_at, icp_filter_spec_approved_by')
    .eq('id', documentId)
    .single()
  expect(error).toBeNull()
  return data!
}

beforeAll(() => {
  service = createTestServiceClient(CONTEXT)
  untyped = service as SupabaseClient
})

afterAll(async () => {
  if (created.length > 0) await deleteTestOrganisations(service, created, CONTEXT)
})

describe('a new ICP version inherits the live search settings', () => {
  it('copies the settings, the pending proposal and the approval stamp, and changes the words', async () => {
    const org = await seedOrganisation('inherit-copy')
    const first = await seedActiveDocument(org, 'icp', {
      icp_filter_spec: LIVE_SETTINGS,
      icp_filter_spec_proposed: PROPOSAL,
      icp_filter_spec_approved_at: APPROVED_AT,
    })

    const promoted = await promote(org, 'icp', { words: 'second icp, prose edited' })
    const next = await readSettings(promoted.id)

    expect(promoted.id).not.toBe(first)
    expect(next.status).toBe('active')
    expect(next.version).toBe('2')
    expect(next.content).toEqual({ words: 'second icp, prose edited' })
    expect(next.icp_filter_spec).toEqual(LIVE_SETTINGS)
    expect(next.icp_filter_spec_proposed).toEqual(PROPOSAL)
    expect(new Date(next.icp_filter_spec_approved_at).toISOString()).toBe(APPROVED_AT)

    // The outgoing row is archived and keeps what it had: the history is not rewritten.
    const previous = await readSettings(first)
    expect(previous.status).toBe('archived')
    expect(previous.icp_filter_spec).toEqual(LIVE_SETTINGS)
  })

  it('leaves a client\'s FIRST ICP with no settings: there is nothing to inherit', async () => {
    const org = await seedOrganisation('inherit-first')
    const promoted = await promote(org, 'icp', { words: 'the first icp this client has had' })
    const row = await readSettings(promoted.id)
    expect(row.version).toBe('1')
    expect(row.icp_filter_spec).toBeNull()
    expect(row.icp_filter_spec_proposed).toBeNull()
    expect(row.icp_filter_spec_approved_at).toBeNull()
    expect(row.icp_filter_spec_approved_by).toBeNull()
  })

  it('does not carry ICP settings onto any other document type', async () => {
    const org = await seedOrganisation('inherit-other')
    await seedActiveDocument(org, 'icp', {
      icp_filter_spec: LIVE_SETTINGS,
      icp_filter_spec_approved_at: APPROVED_AT,
    })
    // A positioning row that somehow carries settings must not pass them on either: the
    // copy is for ICPs, and reading "the active row of this type" would have copied these.
    await seedActiveDocument(org, 'positioning', { icp_filter_spec: { marker: 'stray' } })

    const promoted = await promote(org, 'positioning', { words: 'second positioning' })
    const row = await readSettings(promoted.id)
    expect(row.icp_filter_spec).toBeNull()
    expect(row.icp_filter_spec_proposed).toBeNull()
    expect(row.icp_filter_spec_approved_at).toBeNull()
  })

  it('never reads another organisation\'s settings', async () => {
    const withSettings = await seedOrganisation('inherit-iso-a')
    const without = await seedOrganisation('inherit-iso-b')
    await seedActiveDocument(withSettings, 'icp', { icp_filter_spec: LIVE_SETTINGS })
    await seedActiveDocument(without, 'icp')

    const promoted = await promote(without, 'icp', { words: 'second icp for the other client' })
    expect((await readSettings(promoted.id)).icp_filter_spec).toBeNull()
  })

  it('a revert brings back the old WORDS and keeps the LIVE settings', async () => {
    // Before ADR-061 a revert re-derived the settings. After it, the search does not move:
    // the restored version carries whatever is live now, not what it carried then.
    const org = await seedOrganisation('inherit-revert')
    const first = await seedActiveDocument(org, 'icp', {
      content: { words: 'the original words' },
      icp_filter_spec: { marker: 'settings as of version 1' },
    })
    const second = await promote(org, 'icp', { words: 'rewritten words' })

    // The settings change while version 2 is live, as an approved change would do.
    const NEWER = { marker: 'settings approved while version 2 was live' }
    const { error: updateError } = await untyped
      .from('strategy_documents').update({ icp_filter_spec: NEWER }).eq('id', second.id)
    expect(updateError).toBeNull()

    const { data: reverted, error } = await untyped.rpc('revert_strategy_doc_version', {
      p_document_id: first,
    })
    expect(error).toBeNull()
    const third = await readSettings((reverted as { id: string }).id)

    expect(third.version).toBe('3')
    expect(third.content).toEqual({ words: 'the original words' })
    expect(third.icp_filter_spec).toEqual(NEWER)
    // And the archived first version still holds its own, untouched.
    expect((await readSettings(first)).icp_filter_spec).toEqual({ marker: 'settings as of version 1' })
  })
})

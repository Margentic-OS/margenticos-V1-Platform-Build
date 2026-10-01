// How the strategy page hands the proposal panel its viewer. ADR-061 step 6.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It reads the page's SOURCE. The rule that a client
// never receives a proposal is enforced in loadProposalPanelForViewer, and that function is
// tested by calling it (src/lib/dashboard/__tests__/targeting-proposal-view.test.ts). What
// that test cannot see is the page handing the function the wrong role, and nothing renders
// this page in a test. So this file pins the three lines of wiring that matter:
//
//   1. The role handed over is the one resolveViewingOrg returned, and not a literal.
//   2. The page's own document read, which runs for clients too, does not select the
//      proposal column.
//   3. The panel is rendered only from the state that function returned.
//
// A source scan is a cheap early warning and not the authoritative check. It is here
// because the alternative, for these three lines, is no check at all.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGE = readFileSync(
  join(process.cwd(), 'src', 'app', 'dashboard', '(client)', 'strategy', '[type]', 'page.tsx'),
  'utf8',
)
// Comments say what the code must not do, in words a scan would trip over.
const CODE = PAGE.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

describe('the strategy page and the proposal panel', () => {
  it('control: the scan is reading the page', () => {
    expect(CODE).toContain('export default async function StrategyDocumentPage')
    expect(CODE).toContain('loadProposalPanelForViewer')
  })

  it('takes the viewer\'s role from resolveViewingOrg', () => {
    expect(CODE).toMatch(/const \{ organisationId, role \} = await resolveViewingOrg\(supabase, user, clientParam\)/)
  })

  it('hands that role over as it is, with the document\'s own type, status and organisation', () => {
    const call = CODE.match(/loadProposalPanelForViewer\(\{([\s\S]*?)\}\)/)
    expect(call, 'the call was not found').not.toBeNull()
    const args = call![1].split(',').map(part => part.trim()).filter(Boolean)
    expect(args).toEqual([
      'role',
      'docType',
      'docStatus: doc.status',
      'organisationId: org.id',
      'documentId: doc.id',
    ])
  })

  it('makes exactly one such call', () => {
    expect(CODE.match(/loadProposalPanelForViewer\(/g)).toHaveLength(1)
  })

  it('never selects the proposal column in a read of its own', () => {
    // Every read on this page runs with the viewer's session, clients included.
    expect(CODE).not.toContain('icp_filter_spec_proposed')
    expect(CODE).not.toContain('icp_filter_spec_approved')
  })

  it('renders the panel only from the state that call returned', () => {
    expect(CODE).toMatch(/\{proposalPanel\.state === 'pending' && \(\s*<TargetingProposalPanel view=\{proposalPanel\.view\} \/>\s*\)\}/)
    expect(CODE).toMatch(/\{proposalPanel\.state === 'failed' && <TargetingProposalUnavailable \/>\}/)
    expect(CODE.match(/<TargetingProposalPanel/g)).toHaveLength(1)
  })
})

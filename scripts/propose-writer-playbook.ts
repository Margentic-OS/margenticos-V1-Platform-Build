// Propose a client's writer v2 playbook, through the existing approval flow.
//
//   npx tsx scripts/propose-writer-playbook.ts --org <id> --playbook <file.json> [--note "<why>"]
//
// Creates ONE pending messaging suggestion: the live document's content unchanged, plus
// content.writer_playbook. Approving it in the dashboard makes the playbook live, as a new
// version of the messaging document that can be restored like any other. Nothing ships until
// then, and nothing ships at all for a client whose sequence_writer_v2_enabled is off.
//
// REFUSES WHILE ANOTHER MESSAGING SUGGESTION IS PENDING. There can only be one per client
// (unique index document_suggestions_org_type_pending_unique), and approval replaces the whole
// document, so a playbook proposed on top of one live version and approved after a different
// pending suggestion would silently undo that suggestion. Decide the pending one first; this
// then builds on whatever is live.
//
// The playbook file is client data (its approved examples name real people) and is never
// committed: keep it under .writer-export/, which is gitignored. It is checked in full before
// anything is written (every section present, every never-claim pattern a valid expression).

import * as fs from 'fs'
import * as path from 'path'

for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import { createClient } from '@supabase/supabase-js'
import { playbookProblems, type WriterPlaybook } from '../src/lib/writer-v2/playbook'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const orgId = arg('org')
  const file = arg('playbook')
  if (!orgId || !file) throw new Error('--org and --playbook are required')
  const playbook = JSON.parse(fs.readFileSync(file, 'utf-8')) as WriterPlaybook
  const problems = playbookProblems(playbook)
  if (problems.length > 0) throw new Error(`the playbook is not valid:\n- ${problems.join('\n- ')}`)

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: pending, error: pendingError } = await supabase.from('document_suggestions')
    .select('id').eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'pending').maybeSingle()
  if (pendingError) throw new Error(`reading pending suggestions: ${pendingError.message}`)
  if (pending) throw new Error(`messaging suggestion ${pending.id} is already pending for this client; approve or reject it first, then propose the playbook on top of what is live`)

  const { data: doc, error: docError } = await supabase.from('strategy_documents')
    .select('id, version, content, plain_text').eq('organisation_id', orgId).eq('document_type', 'messaging')
    .eq('status', 'active').is('segment_id', null).maybeSingle()
  if (docError || !doc) throw new Error(`no active default-segment messaging document for ${orgId}`)

  const previous = (doc.content as Record<string, unknown>).writer_playbook as WriterPlaybook | undefined
  if (previous && previous.version >= playbook.version) {
    throw new Error(`the live playbook is already version ${previous.version}; give this one a higher version`)
  }

  const content = { ...(doc.content as Record<string, unknown>), writer_playbook: playbook }
  const { data, error } = await supabase.from('document_suggestions').insert({
    organisation_id: orgId,
    segment_id: null,
    document_id: doc.id,
    document_type: 'messaging',
    field_path: 'full_document',
    current_value: doc.plain_text,
    suggested_value: JSON.stringify(content),
    suggestion_reason:
      `Writer v2 playbook v${playbook.version} added to the messaging document: ${playbook.angles.length} angles, ` +
      `${playbook.examples.length} examples (${playbook.examples.filter(e => e.origin === 'approved').length} approved, ` +
      `${playbook.examples.filter(e => e.origin === 'prototype').length} from the prototype), ` +
      `${playbook.never_claim.length} never-claim rules. Templates and every other section are unchanged.` +
      (arg('note') ? ` ${arg('note')}` : ''),
    confidence_level: 'high',
    signal_count: 0,
    status: 'pending',
    generated_by_model: null,
    revision_note: `Writer v2 playbook v${playbook.version} added`,
  }).select('id').single()
  if (error) throw new Error(`insert failed: ${error.message}`)
  console.log(`Pending messaging suggestion ${data.id}: live v${doc.version} content plus writer_playbook v${playbook.version}.`)
}

main().catch(e => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1) })

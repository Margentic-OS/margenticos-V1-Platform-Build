// DRY RUN. Assembles the exact system and user messages the messaging agent WOULD send,
// and writes them to disk for review. Makes NO model call, NO writes, NO suggestion row.
//
// Usage: npx tsx --env-file=.env.local scripts/dryrun-messaging-prompt.ts <organisation_id>

import { createClient } from '@supabase/supabase-js'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

async function loadSystemPrompt(): Promise<string> {
  const raw = await readFile(join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md'), 'utf-8')
  const idx = raw.indexOf('## System Prompt')
  if (idx === -1) throw new Error('marker not found')
  return raw.slice(idx + '## System Prompt'.length).trim()
}

async function main() {
  const orgId = process.argv[2]
  if (!orgId) {
    console.error('Usage: dryrun-messaging-prompt.ts <organisation_id>')
    process.exit(1)
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Mirror the agent's own preflight and fetches, read-only.
  const { data: org } = await supabase
    .from('organisations').select('name, founder_first_name').eq('id', orgId).single()

  const { data: intake } = await supabase
    .from('intake_responses')
    .select('field_key, field_label, response_value, section, is_critical')
    .eq('organisation_id', orgId).order('section')

  const { data: docs } = await supabase
    .from('strategy_documents')
    .select('id, document_type, version, plain_text, content, status')
    .eq('organisation_id', orgId).in('document_type', ['icp', 'positioning', 'tov'])
    .order('created_at', { ascending: false })

  const system = await loadSystemPrompt()

  // The agent's buildUserMessage is not exported, so this reproduces its inputs and
  // reports what the assembled message contains. The email-1 instruction block is
  // printed verbatim from the agent source so what is reviewed is what ships.
  const agentSrc = await readFile(join(process.cwd(), 'src', 'agents', 'messaging-generation-agent.ts'), 'utf-8')
  const start = agentSrc.indexOf('## EMAIL 1 IS A FRAME WITH A SLOT')
  const end = agentSrc.indexOf('Return ONLY the four-variant JSON below')
  const email1Block = agentSrc.slice(start, end).trim()

  const outDir = process.env.DRYRUN_OUT ?? '.'
  await writeFile(join(outDir, 'dryrun-system-prompt.txt'), system, 'utf-8')
  await writeFile(join(outDir, 'dryrun-email1-block.txt'), email1Block, 'utf-8')

  console.log('=== DRY RUN. No model call was made. ===\n')
  console.log('Organisation      :', org?.name)
  console.log('Sender first name :', org?.founder_first_name)
  console.log('Intake rows       :', intake?.length ?? 0)
  console.log('Upstream docs     :', (docs ?? []).map(d => `${d.document_type} v${d.version} (${d.status}, plain_text=${d.plain_text ? 'set' : 'NULL'})`).join(', '))
  console.log('System prompt     :', system.length, 'chars,', system.split('\n').length, 'lines')
  console.log('\nWritten: dryrun-system-prompt.txt, dryrun-email1-block.txt')
  console.log('\n' + '='.repeat(78))
  console.log('ASSEMBLED EMAIL 1 INSTRUCTION BLOCK (user message)')
  console.log('='.repeat(78) + '\n')
  console.log(email1Block.replace(/\$\{params\.preflight\.sender_first_name\}/g, org?.founder_first_name ?? '[sender]')
                         .replace(/\$\{renderWordCountReminder\(\)\}/g, '[word bands rendered from EMAIL_WORD_LIMITS]'))
}

main().catch(err => { console.error('FAILED:', err); process.exit(1) })

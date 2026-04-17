// scripts/seed-operator.ts
// One-time script to promote an existing public.users row to role = 'operator'.
//
// Run AFTER Doug's first magic link login (which creates the auth.users +
// public.users rows via the on_auth_user_created trigger).
//
// Usage:
//   OPERATOR_EMAIL=you@example.com npx tsx scripts/seed-operator.ts
//
// The script reads .env.local automatically so no manual export is needed.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join } from 'path'

function loadEnv(): void {
  try {
    const lines = readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  } catch {
    // .env.local not found — rely on shell environment variables
  }
}

async function main(): Promise<void> {
  loadEnv()

  const email = process.env.OPERATOR_EMAIL
  if (!email) {
    console.error('Error: OPERATOR_EMAIL environment variable is required.')
    console.error('Usage: OPERATOR_EMAIL=you@example.com npx tsx scripts/seed-operator.ts')
    process.exit(1)
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    console.error('Error: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
    console.error('These are read from .env.local in the project root.')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  const { data, error } = await supabase
    .from('users')
    .update({ role: 'operator' })
    .eq('email', email)
    .select('id, email, role')
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      console.error(`No user found with email: ${email}`)
      console.error('The user must sign in via magic link at least once before running this script.')
    } else {
      console.error(`Failed to promote ${email} to operator:`, error.message)
    }
    process.exit(1)
  }

  console.log(`✓ ${data.email} (id: ${data.id}) promoted to operator role.`)
}

main()

// Supabase server client — use in Server Components, API Routes, and Server Actions.
// Credentials come from environment variables only. Never hardcode.
// See CLAUDE.md — Security section.
//
// EVERY CALL THIS CLIENT MAKES IS BOUNDED. Until 2026-09-07 none of them were, and an
// unanswered read had no ceiling short of the 300s function timeout. The bound lives here
// rather than at each call site so that a read cannot be added without it: there is no
// way to obtain this client and opt out. See read-timeout.ts for why 10s specifically,
// and why that number is safe for writes as well as reads.

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { fetchWithTimeout, SESSION_READ_TIMEOUT_MS } from './read-timeout'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: fetchWithTimeout(SESSION_READ_TIMEOUT_MS) },
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component where cookies are read-only.
            // Safe to ignore — session is refreshed by the proxy on every request.
          }
        },
      },
    }
  )
}

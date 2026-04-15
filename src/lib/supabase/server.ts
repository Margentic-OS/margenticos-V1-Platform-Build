// Supabase server client — use in Server Components, API Routes, and Server Actions.
// Credentials come from environment variables only. Never hardcode.
// See CLAUDE.md — Security section.

// TODO: Install @supabase/supabase-js and @supabase/ssr, then uncomment.
// Run: npm install @supabase/supabase-js @supabase/ssr

// import { createServerClient } from '@supabase/ssr'
// import { cookies } from 'next/headers'
// import type { Database } from '@/types/database'

// export async function createClient() {
//   const cookieStore = await cookies()
//   return createServerClient<Database>(
//     process.env.NEXT_PUBLIC_SUPABASE_URL!,
//     process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
//     {
//       cookies: {
//         getAll() { return cookieStore.getAll() },
//         setAll(cookiesToSet) {
//           cookiesToSet.forEach(({ name, value, options }) =>
//             cookieStore.set(name, value, options)
//           )
//         },
//       },
//     }
//   )
// }

export {}

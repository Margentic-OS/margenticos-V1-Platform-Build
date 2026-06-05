import type { SupabaseClient, User } from '@supabase/supabase-js'

export async function requireOperator(
  sessionClient: SupabaseClient,
  serviceClient: SupabaseClient
): Promise<{ user: User | null; authorized: boolean }> {
  const { data: { user }, error } = await sessionClient.auth.getUser()
  if (error || !user) return { user: null, authorized: false }
  const { data: userRow } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()
  if (!userRow || userRow.role !== 'operator') return { user, authorized: false }
  return { user, authorized: true }
}

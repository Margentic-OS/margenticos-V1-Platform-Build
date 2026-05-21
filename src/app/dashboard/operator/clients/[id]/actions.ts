'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export type SetupStatusField = 'campaigns' | 'linkedin'
export type SetupStatusValue = 'pending' | 'in_progress' | 'complete'

export async function updateSetupStatus(
  orgId: string,
  field: SetupStatusField,
  value: SetupStatusValue,
): Promise<{ error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  const { data: org, error: fetchErr } = await supabase
    .from('organisations')
    .select('setup_status')
    .eq('id', orgId)
    .maybeSingle()

  if (fetchErr || !org) {
    return { error: 'Organisation not found' }
  }

  const current = (org.setup_status as Record<string, string> | null) ?? {}
  const updated = { ...current, [field]: value }

  const { error: updateErr } = await supabase
    .from('organisations')
    .update({ setup_status: updated })
    .eq('id', orgId)

  if (updateErr) {
    return { error: updateErr.message }
  }

  return {}
}

// Intake questionnaire page.
// Server component — loads existing responses, then renders the interactive form.
// Auth enforced by middleware (proxy.ts) — reaching this page means user is authenticated.

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { loadIntakeResponses } from './actions'
import IntakeForm from '@/components/intake/IntakeForm'

export default async function IntakePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const initialValues = await loadIntakeResponses()

  return <IntakeForm initialValues={initialValues} />
}

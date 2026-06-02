// Intake questionnaire page.
// Server component — loads existing responses, then renders the interactive form.
// Auth enforced by this component: getUser() check below redirects unauthenticated users.

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { loadIntakeResponses, loadIntakeFiles } from './actions'
import IntakeForm from '@/components/intake/IntakeForm'

export default async function IntakePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const [initialValues, initialFiles] = await Promise.all([
    loadIntakeResponses(),
    loadIntakeFiles(),
  ])

  return <IntakeForm initialValues={initialValues} initialFiles={initialFiles} />
}

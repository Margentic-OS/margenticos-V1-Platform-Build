// Intake questionnaire page.
// Server component — loads existing responses, then renders the interactive form.
// Auth enforced by this component: getUser() check below redirects unauthenticated users.

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { loadIntakeResponses, loadIntakeFiles } from './actions'
import { loadBuyerProfile } from './buyer-profile-actions'
import { EMPTY_BUYER_PROFILE } from '@/lib/intake/buyer-profile'
import IntakeForm from '@/components/intake/IntakeForm'

export default async function IntakePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const [initialValues, initialFiles, buyerProfile] = await Promise.all([
    loadIntakeResponses(),
    loadIntakeFiles(),
    loadBuyerProfile(),
  ])

  return (
    <IntakeForm
      initialValues={initialValues}
      initialFiles={initialFiles}
      initialBuyerProfile={buyerProfile ?? EMPTY_BUYER_PROFILE}
    />
  )
}

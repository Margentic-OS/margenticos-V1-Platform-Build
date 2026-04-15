// Dashboard placeholder — replaced when the dashboard is built in a later phase.
// Auth is enforced by middleware — reaching this page means the user is authenticated.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="min-h-screen bg-surface-shell flex items-center justify-center">
      <div className="bg-surface-card border border-border-card rounded-[10px] p-6 max-w-sm w-full">
        <p className="text-text-primary text-sm font-medium mb-1">Signed in</p>
        <p className="text-text-secondary text-xs">{user.email}</p>
      </div>
    </div>
  )
}

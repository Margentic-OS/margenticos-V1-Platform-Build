// /dashboard/operator/clients/new
// Operator-only page for creating a new client organisation.
// Layout handles the primary auth check (authenticated + role = operator).
// The server action performs its own independent auth check on every submit.

import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { CreateOrgForm } from './CreateOrgForm'

export default async function NewClientPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <OperatorTopbar
        eyebrow="Operator view"
        title="New client"
        userEmail={user.email}
      />
      <div className="flex-1 px-6 py-8 max-w-2xl">
        <Link
          href="/dashboard/operator/clients"
          className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mb-5"
        >
          <span aria-hidden="true">←</span> All clients
        </Link>
        <p className="text-xs text-text-secondary mb-6">
          Creates the organisation record, generates a one-time account setup link,
          and sends the welcome email to the founder.
        </p>
        <CreateOrgForm />
      </div>
    </div>
  )
}

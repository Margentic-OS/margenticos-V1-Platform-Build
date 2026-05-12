'use client'

import { useActionState } from 'react'
import { createOrganisation, type CreateOrgState } from './actions'

const initialState: CreateOrgState = { status: 'idle' }

export function CreateOrgForm() {
  const [state, formAction, isPending] = useActionState(createOrganisation, initialState)

  if (state.status === 'success') {
    return (
      <div className="max-w-lg">
        <div className="bg-[#EBF5E6] border border-[#BDDAB0] rounded-[10px] p-6 mb-4">
          <p className="text-sm font-medium text-[#2B5A1E] mb-1">Organisation created</p>
          <p className="text-sm text-[#2B5A1E]">
            <strong>{state.orgName}</strong> has been created and the welcome email has been sent.
          </p>
        </div>
        <a
          href={`/dashboard/operator?client=${state.orgId}`}
          className="inline-block px-4 py-2 text-sm font-medium text-[#F5F0E8] bg-brand-green rounded-[6px] hover:opacity-90 transition-opacity"
        >
          Go to organisation
        </a>
      </div>
    )
  }

  return (
    <form action={formAction} className="max-w-lg space-y-5">
      {state.status === 'error' && (
        <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-[8px] p-4">
          <p className="text-sm text-[#991B1B]">{state.message}</p>
        </div>
      )}

      <div>
        <label htmlFor="org_name" className="block text-xs font-medium text-text-primary mb-1.5">
          Organisation name <span className="text-red-500">*</span>
        </label>
        <input
          id="org_name"
          name="org_name"
          type="text"
          required
          autoComplete="off"
          className="w-full px-3 py-2 text-sm border border-border-card rounded-[6px] bg-surface-card text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-green"
        />
      </div>

      <div>
        <label htmlFor="founder_first_name" className="block text-xs font-medium text-text-primary mb-1.5">
          Founder first name <span className="text-red-500">*</span>
        </label>
        <input
          id="founder_first_name"
          name="founder_first_name"
          type="text"
          required
          autoComplete="off"
          className="w-full px-3 py-2 text-sm border border-border-card rounded-[6px] bg-surface-card text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-green"
        />
        <p className="mt-1 text-[11px] text-text-secondary">
          Used in reply sign-offs. Must be set before campaigns go live.
        </p>
      </div>

      <div>
        <label htmlFor="founder_email" className="block text-xs font-medium text-text-primary mb-1.5">
          Founder email <span className="text-red-500">*</span>
        </label>
        <input
          id="founder_email"
          name="founder_email"
          type="email"
          required
          autoComplete="off"
          className="w-full px-3 py-2 text-sm border border-border-card rounded-[6px] bg-surface-card text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-green"
        />
        <p className="mt-1 text-[11px] text-text-secondary">
          The welcome email with account setup link will be sent here.
        </p>
      </div>

      <div>
        <label htmlFor="currency" className="block text-xs font-medium text-text-primary mb-1.5">
          Currency <span className="text-red-500">*</span>
        </label>
        <select
          id="currency"
          name="currency"
          required
          defaultValue="GBP"
          className="w-full px-3 py-2 text-sm border border-border-card rounded-[6px] bg-surface-card text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-green"
        >
          <option value="GBP">GBP (£)</option>
          <option value="EUR">EUR (€)</option>
          <option value="USD">USD ($)</option>
        </select>
      </div>

      <div>
        <label htmlFor="monthly_meetings_target" className="block text-xs font-medium text-text-primary mb-1.5">
          Monthly meetings target <span className="text-red-500">*</span>
        </label>
        <input
          id="monthly_meetings_target"
          name="monthly_meetings_target"
          type="number"
          required
          min="1"
          defaultValue="8"
          className="w-full px-3 py-2 text-sm border border-border-card rounded-[6px] bg-surface-card text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-green"
        />
      </div>

      <div>
        <label htmlFor="contract_start_date" className="block text-xs font-medium text-text-primary mb-1.5">
          Contract start date <span className="text-red-500">*</span>
        </label>
        <input
          id="contract_start_date"
          name="contract_start_date"
          type="date"
          required
          className="w-full px-3 py-2 text-sm border border-border-card rounded-[6px] bg-surface-card text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-green"
        />
      </div>

      <div>
        <label htmlFor="contract_end_date" className="block text-xs font-medium text-text-primary mb-1.5">
          Contract end date
          <span className="ml-1 text-[11px] font-normal text-text-secondary">(optional)</span>
        </label>
        <input
          id="contract_end_date"
          name="contract_end_date"
          type="date"
          className="w-full px-3 py-2 text-sm border border-border-card rounded-[6px] bg-surface-card text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-green"
        />
      </div>

      <div className="pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="px-5 py-2.5 text-sm font-medium text-[#F5F0E8] bg-brand-green rounded-[6px] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? 'Creating...' : 'Create organisation'}
        </button>
      </div>
    </form>
  )
}

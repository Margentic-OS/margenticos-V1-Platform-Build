'use client'

import { useFormStatus } from 'react-dom'

interface SubmitButtonProps {
  children: React.ReactNode
  pendingText: string
}

export function SubmitButton({ children, pendingText }: SubmitButtonProps) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full py-2 text-sm font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? pendingText : children}
    </button>
  )
}

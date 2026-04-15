// Login page — magic link (passwordless email) only.
// No passwords. No OAuth. See prd/sections/04-auth.md.
// Design tokens from /docs/design.md.

import { sendMagicLink } from './actions'

interface LoginPageProps {
  searchParams: Promise<{ sent?: string; error?: string }>
}

const ERROR_MESSAGES: Record<string, string> = {
  email_required: 'Please enter your email address.',
  send_failed: 'Something went wrong. Please try again.',
  auth_failed: 'The link has expired or is invalid. Please request a new one.',
  missing_code: 'Invalid link. Please request a new one.',
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams
  const sent = params.sent === 'true'
  const errorMessage = params.error ? ERROR_MESSAGES[params.error] ?? 'Something went wrong.' : null

  return (
    <div className="min-h-screen bg-surface-shell flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Wordmark */}
        <div className="mb-8 text-center">
          <span className="text-brand-green text-lg font-medium tracking-tight">
            MargenticOS
          </span>
        </div>

        {/* Card */}
        <div className="bg-surface-card border border-border-card rounded-[10px] p-6">

          {sent ? (
            /* Confirmation state — shown after magic link is sent */
            <div className="text-center">
              <p className="text-text-primary text-sm font-medium mb-1">
                Check your inbox
              </p>
              <p className="text-text-secondary text-xs leading-relaxed">
                We sent a link to your email. Click it to sign in.
                You can close this tab.
              </p>
            </div>
          ) : (
            /* Default state — email form */
            <>
              <p className="text-text-primary text-sm font-medium mb-1">
                Sign in
              </p>
              <p className="text-text-secondary text-xs mb-5">
                Enter your email and we&apos;ll send you a link.
              </p>

              {errorMessage && (
                <div className="mb-4 px-3 py-2 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA]">
                  <p className="text-[#8B2020] text-xs">{errorMessage}</p>
                </div>
              )}

              <form action={sendMagicLink} className="space-y-3">
                <input
                  type="email"
                  name="email"
                  placeholder="your@email.com"
                  required
                  autoFocus
                  className="w-full px-3 py-2 text-sm text-text-primary bg-surface-content border border-border-card rounded-[6px] placeholder:text-text-muted focus:outline-none focus:border-brand-green-accent transition-colors"
                />
                <button
                  type="submit"
                  className="w-full py-2 text-sm font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity"
                >
                  Send me a link
                </button>
              </form>
            </>
          )}

        </div>

      </div>
    </div>
  )
}

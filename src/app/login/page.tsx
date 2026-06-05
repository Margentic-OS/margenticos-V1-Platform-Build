// Login page — magic link (passwordless email) only.
// No passwords. No OAuth. See prd/sections/04-auth.md.
// Design tokens from /docs/design.md.

import { sendMagicLink, verifyOtpCode } from './actions'

interface LoginPageProps {
  searchParams: Promise<{ sent?: string; error?: string; next?: string; email?: string }>
}

const ERROR_MESSAGES: Record<string, string> = {
  email_required: 'Please enter your email address.',
  send_failed: 'Something went wrong. Please try again.',
  rate_limited: 'Too many login attempts. Please try again in an hour.',
  auth_failed: 'The link has expired or is invalid. Please request a new one.',
  missing_code: 'Invalid link. Please request a new one.',
  code_invalid: 'That code is invalid. Check the email or request a new link.',
  code_expired: 'That code has expired. Request a new link.',
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams
  const sent = params.sent === 'true'
  const sentEmail = params.email ?? ''
  const errorMessage = params.error ? ERROR_MESSAGES[params.error] ?? 'Something went wrong.' : null
  const next =
    params.next &&
    params.next.startsWith('/dashboard/') &&
    !params.next.startsWith('/dashboard/operator')
      ? params.next
      : null

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
            /* Post-send state — code entry + link confirmation */
            <>
              <p className="text-text-primary text-sm font-medium mb-1">
                Check your inbox
              </p>
              <p className="text-text-secondary text-xs mb-5 leading-relaxed">
                We sent a sign-in link and 8-digit code to{' '}
                {sentEmail ? <span className="text-text-primary">{sentEmail}</span> : 'your email'}.
                Click the link or enter the code below.
              </p>

              {errorMessage && (
                <div className="mb-4 px-3 py-2 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA]">
                  <p className="text-[#8B2020] text-xs">{errorMessage}</p>
                </div>
              )}

              <form action={verifyOtpCode} className="space-y-3">
                <input type="hidden" name="email" value={sentEmail} />
                {next && <input type="hidden" name="next" value={next} />}
                <input
                  type="text"
                  name="token"
                  inputMode="numeric"
                  pattern="\d{8}"
                  maxLength={8}
                  placeholder="00000000"
                  autoFocus
                  autoComplete="one-time-code"
                  className="w-full px-3 py-2 text-sm text-text-primary bg-surface-content border border-border-card rounded-[6px] placeholder:text-text-muted focus:outline-none focus:border-brand-green-accent transition-colors tracking-widest text-center font-mono"
                />
                <button
                  type="submit"
                  className="w-full py-2 text-sm font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity"
                >
                  Sign in with code
                </button>
              </form>

              <p className="mt-4 text-center text-xs text-text-secondary">
                <a href="/login" className="hover:underline transition-colors">
                  Send a new link
                </a>
              </p>
            </>
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
                {next && <input type="hidden" name="next" value={next} />}
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

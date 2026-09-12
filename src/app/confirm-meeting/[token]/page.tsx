// The client's one-click confirmation page. Public: no login, no session.
//
// The signed token in the URL is the whole of the authentication, and it names one meeting of
// one organisation. It is checked by POST /api/meetings/confirm, never here: this page only
// renders buttons.
//
// ═════════════════════════════════════════════════════════════════════════════
// SCANNER SAFETY IS WHY THIS PAGE EXISTS AT ALL.
//
// The email's two buttons are ordinary links, and email security scanners follow links
// before a person ever sees them. So the link opens THIS PAGE, which changes nothing, and a
// person then clicks a button that POSTs. The confirm route exports no GET and no HEAD, so
// even a scanner that finds the API path cannot record an answer.
//
// The email's ?decision= is read as a HINT, and highlights the button the client pressed. It
// is deliberately not acted on: acting on a query parameter would be a GET that writes, which
// is the thing this page is designed to prevent.

import { ConfirmMeetingButtons } from './ConfirmMeetingButtons'

export const metadata = {
  title: 'Did your meeting happen?',
  // Keeps this page out of search results. It carries a signed token in its URL.
  robots: { index: false, follow: false },
}

interface ConfirmMeetingPageProps {
  params: Promise<{ token: string }>
  searchParams: Promise<{ decision?: string }>
}

export default async function ConfirmMeetingPage({ params, searchParams }: ConfirmMeetingPageProps) {
  const { token } = await params
  const { decision } = await searchParams
  const hint = decision === 'held' || decision === 'no_show' ? decision : null

  return (
    <main className="min-h-screen bg-[#F5F0E8] flex items-center justify-center px-5 py-12">
      <div className="w-full max-w-[520px] bg-white border border-[#E8E2D8] rounded-[10px] overflow-hidden">
        <div className="bg-brand-green-operator px-8 py-6">
          <p className="text-[13px] font-medium uppercase tracking-[0.06em] text-[#F5F0E8]">
            MargenticOS
          </p>
        </div>
        <div className="px-8 py-8">
          <h1 className="text-[18px] font-medium text-[#1A1916] mb-3">Did your meeting happen?</h1>
          <p className="text-[14px] text-[#4A4A4A] leading-relaxed mb-6">
            One click is all we need. We bill for meetings that went ahead, so if it did not
            happen, telling us costs you nothing.
          </p>
          <ConfirmMeetingButtons token={token} hint={hint} />
        </div>
      </div>
    </main>
  )
}

import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'MargenticOS',
  description: 'Agentic pipeline generation for founder-led B2B firms',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

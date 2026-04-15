// Root page — redirects to login.
// Authentication and routing is handled in (auth)/login and (client)/dashboard.
import { redirect } from 'next/navigation'

export default function RootPage() {
  redirect('/login')
}

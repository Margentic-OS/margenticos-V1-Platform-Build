import * as Sentry from '@sentry/nextjs'
import type { ErrorEvent, EventHint } from '@sentry/nextjs'
import { scrubSensitiveData } from './sentry.scrubber'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,

  debug: false,
  beforeSend: (event: ErrorEvent, hint: EventHint) => scrubSensitiveData(event, hint),
})

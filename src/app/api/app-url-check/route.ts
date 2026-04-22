import { NextResponse } from 'next/server'
import { getAppUrl } from '@/lib/urls/app-url'

export async function GET() {
  const isVercelProduction = process.env.VERCEL_ENV === 'production'
  const isLocalProduction = process.env.NODE_ENV === 'production' && !process.env.VERCEL_ENV

  if (isVercelProduction || isLocalProduction) {
    return new NextResponse('Not found', { status: 404 })
  }

  return NextResponse.json({
    appUrl: getAppUrl(),
    nodeEnv: process.env.NODE_ENV,
    hasPublicAppUrl: !!process.env.NEXT_PUBLIC_APP_URL,
    hasVercelUrl: !!process.env.VERCEL_URL,
  })
}

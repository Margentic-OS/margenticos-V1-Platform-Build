import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
    env: process.env.VERCEL_ENV ?? 'development',
    deployedAt: process.env.VERCEL_GIT_COMMIT_TIMESTAMP ?? null,
  })
}

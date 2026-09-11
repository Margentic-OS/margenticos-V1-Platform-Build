// The retry counter: one RPC per retry, never a throw, never a block.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '@/lib/logger'
import {
  recordGatewayRetry,
  installGatewayRetryCounter,
  GATEWAY_RETRY_HOOK,
} from '../gateway-retry-counter'

const control = vi.hoisted(() => ({
  rpc: vi.fn(),
  createThrows: null as Error | null,
}))

vi.mock('@/lib/supabase/service-role', () => ({
  createServiceRoleClient: async () => {
    if (control.createThrows) throw control.createThrows
    return { rpc: control.rpc }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  control.createThrows = null
  control.rpc.mockResolvedValue({ data: null, error: null })
})

describe('recordGatewayRetry', () => {
  it('adds one through the RPC, naming the method', async () => {
    await recordGatewayRetry({ method: 'GET' })
    expect(control.rpc).toHaveBeenCalledTimes(1)
    expect(control.rpc).toHaveBeenCalledWith('record_gateway_retry', { p_method: 'GET' })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a failed write is logged and swallowed, never thrown into the library', async () => {
    control.rpc.mockResolvedValue({ data: null, error: { message: 'Gateway Timeout' } })
    await expect(recordGatewayRetry({ method: 'HEAD' })).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not record a retry/),
      expect.objectContaining({ method: 'HEAD', error: 'Gateway Timeout' }),
    )
  })

  it('a client that cannot be built is logged and swallowed too', async () => {
    control.createThrows = new Error('SUPABASE_SERVICE_ROLE_KEY environment variable not set')
    await expect(recordGatewayRetry({ method: 'GET' })).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/recording a retry threw/),
      expect.objectContaining({ method: 'GET' }),
    )
  })
})

describe('installGatewayRetryCounter', () => {
  it('sets the global the patched library calls, and calling it records one retry', async () => {
    const host: Record<string, unknown> = {}
    installGatewayRetryCounter(host)

    expect(typeof host[GATEWAY_RETRY_HOOK]).toBe('function')
    const result = (host[GATEWAY_RETRY_HOOK] as (e: { method: string }) => unknown)({ method: 'GET' })
    // The hook returns at once: it starts the write and does not make the retry wait for it.
    expect(result).toBeUndefined()

    await vi.waitFor(() => expect(control.rpc).toHaveBeenCalledWith('record_gateway_retry', { p_method: 'GET' }))
  })

  it('uses the same global name the patch looks up', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const patched = readFileSync(
      join(process.cwd(), 'node_modules', '@supabase', 'postgrest-js', 'dist', 'index.mjs'),
      'utf8',
    )
    expect(patched).toContain(`globalThis.${GATEWAY_RETRY_HOOK}`)
  })
})

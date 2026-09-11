import { describe, it, expect } from 'vitest'
import { describeQueryFailure } from '../describe-query-failure'

describe('describeQueryFailure', () => {
  it('names the status when the body was empty, which is every failed HEAD count', () => {
    expect(describeQueryFailure({
      error: { message: '' },
      status: 504,
      statusText: 'Gateway Timeout',
    })).toBe('HTTP 504 Gateway Timeout, with no error body')
  })

  it('does not repeat a message that only restates the status text', () => {
    expect(describeQueryFailure({
      error: { message: 'Gateway Timeout' },
      status: 504,
      statusText: 'Gateway Timeout',
    })).toBe('HTTP 504 Gateway Timeout')
  })

  it('includes the code, the message and the details when they are present', () => {
    expect(describeQueryFailure({
      error: { message: 'column x does not exist', code: '42703', details: 'on table y' },
      status: 400,
      statusText: 'Bad Request',
    })).toBe('HTTP 400 Bad Request, code 42703: column x does not exist (details: on table y)')
  })

  it('says there was no HTTP response when the request never got one', () => {
    expect(describeQueryFailure({
      error: { message: 'FetchError: fetch failed', code: '', details: '' },
      status: 0,
      statusText: '',
    })).toBe('no HTTP response: FetchError: fetch failed')
  })

  it('still works for a caller that has only the error', () => {
    expect(describeQueryFailure({ error: { message: 'permission denied' } }))
      .toBe('permission denied')
  })

  it('never returns an empty string', () => {
    expect(describeQueryFailure({ error: { message: '' } }))
      .toBe('no status, code or message was returned')
  })
})

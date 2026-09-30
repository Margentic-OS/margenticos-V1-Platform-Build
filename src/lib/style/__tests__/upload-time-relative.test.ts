// A RELATIVE TIME WORD IS CHECKED AGAINST THE DAY IT SENDS.
//
// The fault this exists for: copy that is TRUE when written and FALSE when it goes out.
// Email 3 sends ten days after upload, so "this week" about an event five days old is
// correct at writing time and wrong by the time anybody reads it.
//
// RULE ZERO. Every fixture is invented.

import { describe, it, expect } from 'vitest'
import { findUploadTimeRelativeFaults } from '../upload-time-relative'
import { sendDayOffset } from '@/lib/integrations/handlers/instantly/syncSequenceShell'

const UPLOAD = new Date('2026-09-30T09:00:00Z')

/**
 * THE EVENT DATE IS CHOSEN TO SIT ON A MONTH BOUNDARY, and that is not fixture convenience.
 *
 * relative-time.ts measures in WHOLE CALENDAR MONTHS and its windows are deliberately
 * generous: "this gate exists to catch a four-month error, not to arbitrate a fortnight", so
 * "this week" is allowed up to one month. The largest send offset is 17 days, which is under
 * a month, so a phrase can only move from inside a window to outside it by CROSSING A MONTH
 * BOUNDARY.
 *
 * 31 August, uploaded 30 September, is one month: inside "this week"'s window. By the time
 * email 3 sends on 10 October it is two months, and outside it.
 *
 * THE LIMIT THIS IMPLIES IS REAL AND IS NOT FIXED HERE. "This week" said about something
 * five days old is still wrong when email 3 sends ten days later, and this check cannot see
 * it, because at month granularity both dates read as the same month. Catching that needs
 * day- or week-granular windows for the short phrases, which relative-time.ts deliberately
 * does not have. That is a separate decision about the writing-time gate, not about the
 * clock, and it belongs with the operator.
 */
const CROSSES_A_MONTH = '2026-08-31'

const candidates = [{ date: CROSSES_A_MONTH, observation: 'You spoke at the regional conference about scheduling.' }]
const email = (position: number, body: string) => ({ sequence_position: position, body })

describe('the send offsets come from the sending tool\'s own schedule', () => {
  it('places the four steps on days 0, 3, 10 and 17', () => {
    // Derived from defaultDelays rather than restated, so the offsets cannot drift from the
    // gaps the shell sync writes.
    expect([1, 2, 3, 4].map(p => sendDayOffset(p, 4))).toEqual([0, 3, 10, 17])
  })
})

describe('a phrase true at upload and false at send time', () => {
  const body = 'You spoke at the regional conference this week about scheduling. Worth a look?'

  it('is CLEAN on email 1, which sends on the day of upload', () => {
    expect(findUploadTimeRelativeFaults({ emails: [email(1, body)], candidates, uploadedAt: UPLOAD })).toEqual([])
  })

  it('is a FAULT on email 3, which sends ten days later', () => {
    const faults = findUploadTimeRelativeFaults({ emails: [email(3, body)], candidates, uploadedAt: UPLOAD })
    expect(faults).toHaveLength(1)
    expect(faults[0].position).toBe(3)
    expect(faults[0].sendsInDays).toBe(10)
    expect(faults[0].phrase).toBe('this week')
    // THE FIELD THAT MAKES THE COUNT READABLE. This one is not a writing-time fault that
    // got through; it is correct when written and wrong when read.
    expect(faults[0].onlyWrongAtSendTime).toBe(true)
    expect(faults[0].sentence).toContain('this week')
  })

  it('reports EVERY position that has gone stale, and only those', () => {
    // Email 1 sends on the day of upload and is clean. Emails 2 and 3 both cross the month
    // boundary, so both are faults: the offsets are 3 and 10 days and the event is 31 August.
    // Naming only the latest would let a rewrite fix one email and ship the other.
    const faults = findUploadTimeRelativeFaults({
      emails: [email(1, body), email(2, body), email(3, body)], candidates, uploadedAt: UPLOAD,
    })
    expect(faults.map(f => f.position).sort()).toEqual([2, 3])
    expect(faults.every(f => f.onlyWrongAtSendTime)).toBe(true)
  })
})

describe('telling the two clocks apart', () => {
  it('marks a phrase ALREADY wrong at upload as not a send-time fault', () => {
    // Eight months old and called "last month": wrong on the day it was written. It is still
    // reported, because it is still wrong, but it is the writing-time gate's miss and not
    // this check's finding.
    const old = [{ date: '2026-01-20', observation: 'You spoke at the regional conference about scheduling.' }]
    const faults = findUploadTimeRelativeFaults({
      emails: [email(3, 'You spoke at the regional conference last month about scheduling.')],
      candidates: old, uploadedAt: UPLOAD,
    })
    expect(faults).toHaveLength(1)
    expect(faults[0].onlyWrongAtSendTime).toBe(false)
  })
})

describe('it stays quiet where it should', () => {
  it('says nothing about copy with no relative time word', () => {
    expect(findUploadTimeRelativeFaults({
      emails: [email(3, 'You spoke at the regional conference on 25 September about scheduling.')],
      candidates, uploadedAt: UPLOAD,
    })).toEqual([])
  })

  it('says nothing when the shift stays INSIDE one calendar month, which is the known limit', () => {
    // Five days before upload, email 3 sending ten days later. Still "this week" by the
    // month-granular windows, and genuinely stale to the reader. See CROSSES_A_MONTH.
    const recent = [{ date: '2026-09-25', observation: 'You spoke at the regional conference about scheduling.' }]
    expect(findUploadTimeRelativeFaults({
      emails: [email(3, 'You spoke at the regional conference this week about scheduling.')],
      candidates: recent, uploadedAt: UPLOAD,
    })).toEqual([])
  })

  it('says nothing when no finding resembles the sentence, rather than demanding a date', () => {
    // Fails open, the same way the writing-time check does: a relative word about something
    // outside the findings is the traceability check's problem.
    expect(findUploadTimeRelativeFaults({
      emails: [email(3, 'Something unrelated happened this week.')],
      candidates, uploadedAt: UPLOAD,
    })).toEqual([])
  })

  it('says nothing about an empty or absent body', () => {
    expect(findUploadTimeRelativeFaults({
      emails: [{ sequence_position: 2, body: '' }, { sequence_position: 3, body: null }],
      candidates, uploadedAt: UPLOAD,
    })).toEqual([])
  })
})

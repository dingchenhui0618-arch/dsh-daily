import test from 'node:test'
import { strict as assert } from 'node:assert'
import { dayKey, missedToday, msUntilNext } from '../src/schedule.js'

const HOUR = 3600 * 1000

test('dayKey uses the local calendar and pads month and day', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 9, 0)), '2026-01-05')
  assert.equal(dayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31')
  assert.equal(dayKey(new Date(2026, 9, 8, 0, 0)), '2026-10-08')
})

test('msUntilNext returns the remaining time when today s target is ahead', () => {
  const ms = msUntilNext(11, 0, new Date(2026, 9, 8, 9, 0, 0))
  assert.equal(ms, 2 * HOUR)
})

test('msUntilNext rolls over to tomorrow once the target has passed', () => {
  const ms = msUntilNext(11, 0, new Date(2026, 9, 8, 12, 30, 0))
  assert.ok(Math.abs(ms - 22.5 * HOUR) < 60 * 1000, 'expected ~22.5h, got ' + ms)
})

test('msUntilNext never returns zero, so arming cannot spin', () => {
  assert.equal(msUntilNext(11, 0, new Date(2026, 9, 8, 11, 0, 0)), 24 * HOUR)
  assert.ok(msUntilNext(11, 0, new Date(2026, 9, 8, 11, 0, 1)) > 23 * HOUR)
})

test('msUntilNext accepts a timestamp as well as a Date', () => {
  const at = new Date(2026, 9, 8, 10, 30, 0).getTime()
  assert.equal(msUntilNext(11, 0, at), 30 * 60 * 1000)
})

test('missedToday is false before the target and true after it', () => {
  assert.equal(missedToday(11, 0, new Date(2026, 9, 8, 10, 59, 0), undefined), false)
  assert.equal(missedToday(11, 0, new Date(2026, 9, 8, 11, 30, 0), undefined), true)
})

test('missedToday is false when today already has a report', () => {
  const after = new Date(2026, 9, 8, 11, 30, 0)
  assert.equal(missedToday(11, 0, after, '2026-10-08'), false)
  assert.equal(missedToday(11, 0, after, '2026-10-07'), true)
})

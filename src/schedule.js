// Pure date arithmetic for the daily trigger. Kept apart from host.js so the
// "when does it fire next" question can be tested without a running harness.

/** Local calendar key, e.g. 2026-10-08. Never UTC: the user means their own 11:00. */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date)
  const month = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (month < 10 ? '0' + month : String(month)) + '-' + (day < 10 ? '0' + day : String(day))
}

/**
 * Milliseconds from `now` until the next occurrence of hour:minute local time.
 * Strictly in the future: when `now` is exactly the target, it returns a full
 * day rather than zero, so arming can never produce a zero-delay loop.
 */
export function msUntilNext(hour, minute, now) {
  const current = now instanceof Date ? now : new Date(now)
  const target = new Date(current.getTime())
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= current.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime() - current.getTime()
}

/**
 * Has today's run already been missed? True when the clock is past today's
 * target but no report exists for today — the case where the machine was off at
 * 11:00 and should catch up on the next start rather than waiting a full day.
 */
export function missedToday(hour, minute, now, todayKey) {
  const current = now instanceof Date ? now : new Date(now)
  const target = new Date(current.getTime())
  target.setHours(hour, minute, 0, 0)
  const passed = target.getTime() <= current.getTime()
  if (todayKey === undefined || todayKey === null) return passed
  return passed && dayKey(current) !== todayKey
}

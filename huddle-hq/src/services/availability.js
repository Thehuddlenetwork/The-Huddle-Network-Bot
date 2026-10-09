'use strict';
// Game Scheduler: finds kickoff times both owners can make, from their saved availability.
const { WINDOWS, WEEKDAYS } = require('../constants');
const { zoneOf, at, parts, MIN, HOUR, PT } = require('../lib/time');

const DEFAULT_DAYS = WEEKDAYS.map((_, i) => i + 1);
const DEFAULT_WINDOWS = ['evening', 'prime'];

function profile(member) {
  const days = member && member.avail_days ? member.avail_days.split(',').map(Number).filter(Boolean) : null;
  const windows = member && member.avail_windows ? member.avail_windows.split(',').filter((w) => WINDOWS[w]) : null;
  return {
    zone: zoneOf(member && member.timezone),
    days: new Set(days && days.length ? days : DEFAULT_DAYS),
    windows: windows && windows.length ? windows : DEFAULT_WINDOWS,
    isSet: !!(days && days.length && windows && windows.length),
  };
}

function isFree(prof, ms) {
  for (const key of prof.windows) {
    const w = WINDOWS[key];
    for (const dayOffset of [0, -1]) {
      const dayStartMs = at(ms, dayOffset, 0, 0, prof.zone);
      const dayWeekday = parts(dayStartMs + HOUR * 12, prof.zone).weekday;
      if (!prof.days.has(dayWeekday)) continue;
      const start = at(ms, dayOffset, w.start, 0, prof.zone);
      const end = at(ms, dayOffset, w.end, 0, prof.zone);
      if (ms >= start && ms < end) return true;
    }
  }
  return false;
}

// Up to n kickoff times between fromMs and untilMs that work for both, at least 3 hours apart.
// Prefers 5 to 9 PM PT, when the most THN viewers are on.
function suggest(memberA, memberB, fromMs, untilMs, n = 3) {
  const a = profile(memberA);
  const b = profile(memberB);
  const step = 30 * MIN;
  let t = Math.ceil((fromMs + 45 * MIN) / step) * step;
  const candidates = [];
  for (; t <= untilMs && candidates.length < 400; t += step) {
    if (isFree(a, t) && isFree(a, t + 59 * MIN) && isFree(b, t) && isFree(b, t + 59 * MIN)) {
      const h = parts(t, PT).hour;
      candidates.push({ ms: t, prime: h >= 17 && h <= 21 ? 0 : 1 });
    }
  }
  candidates.sort((x, y) => x.prime - y.prime || x.ms - y.ms);
  const picked = [];
  for (const c of candidates) {
    if (picked.every((p) => Math.abs(p - c.ms) >= 3 * HOUR)) picked.push(c.ms);
    if (picked.length >= n) break;
  }
  return { slots: picked.sort((x, y) => x - y), aSet: a.isSet, bSet: b.isSet };
}

function describe(member) {
  const p = profile(member);
  const days = WEEKDAYS.filter((_, i) => p.days.has(i + 1));
  return {
    tz: (member && member.timezone) || 'PT',
    days: days.length === 7 ? 'Every day' : days.join(', '),
    windows: p.windows.map((w) => WINDOWS[w].label).join(', '),
    isSet: p.isSet,
  };
}

module.exports = { profile, isFree, suggest, describe };

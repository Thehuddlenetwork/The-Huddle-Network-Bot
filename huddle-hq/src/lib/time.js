'use strict';
// Time-zone math with the built-in Intl API (no libraries). League clock is Pacific.
const { ADVANCE, TIMEZONES } = require('../constants');

const PT = 'America/Los_Angeles';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const fmtCache = new Map();
function formatter(zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(zone, f);
  }
  return f;
}

function parts(ms, zone = PT) {
  const out = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour % 24, minute: +out.minute, second: +out.second,
    weekday: WD[out.weekday],
  };
}

// Minutes the zone is ahead of UTC at instant ms.
function offset(ms, zone) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = parts(whole, zone);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole) / MIN;
}

// Wall-clock time in a zone -> epoch ms. Day/hour overflow is normalised (hour 26 = 2 AM next day).
function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, zone = PT) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = offset(guess, zone);
  let ms = guess - off1 * MIN;
  const off2 = offset(ms, zone);
  if (off2 !== off1) ms = guess - off2 * MIN;
  return ms;
}

// The wall-clock time hour:minute on (day of ms + dayOffset) in zone.
function at(ms, dayOffset, hour, minute = 0, zone = PT) {
  const p = parts(ms, zone);
  return zonedToUtc({ year: p.year, month: p.month, day: p.day + dayOffset, hour, minute }, zone);
}

const startOfDay = (ms, zone = PT) => at(ms, 0, 0, 0, zone);
const weekday = (ms, zone = PT) => parts(ms, zone).weekday;

// Monday 00:00 PT of the week containing ms.
function weekStart(ms) {
  return at(ms, -(weekday(ms) - 1), 0, 0, PT);
}

function dayKey(ms, zone = PT) {
  const p = parts(ms, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Next advance slot (Mon/Wed/Fri 8 PM PT).
// strict = true: first slot on a later calendar day than fromMs (used right after an advance).
// strict = false: first slot after fromMs.
function nextAdvanceSlot(fromMs, strict = false) {
  for (let i = 0; i <= 9; i++) {
    const slot = at(fromMs, i, ADVANCE.hour, ADVANCE.minute, PT);
    if (!ADVANCE.days.includes(weekday(slot))) continue;
    if (strict ? i === 0 : slot <= fromMs) continue;
    return slot;
  }
  throw new Error('No advance slot found');
}

// Same 8 PM PT on the following day (flex-day rollover).
function rollAdvance(ms) {
  return at(ms, 1, ADVANCE.hour, ADVANCE.minute, PT);
}

// Discord timestamp tag: every member sees it in their own time zone.
function ts(ms, style = 'F') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function fmtPT(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PT, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(ms)) + ' PT';
}

// Plain-text time in a member's zone, for places Discord timestamps don't render (button labels).
function fmtIn(ms, tzCode = 'PT') {
  const zone = zoneOf(tzCode);
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(ms))} ${TIMEZONES[tzCode] ? tzCode : 'PT'}`;
}

function parseClock(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  if (t === 'noon') return { hour: 12, minute: 0, assumedPm: false };
  if (t === 'midnight') return { hour: 0, minute: 0, assumedPm: false };
  const m = t.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?(pt|pst|pdt|et|est|edt|ct|cst|cdt|mt|mst|mdt)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const mer = m[3];
  if (minute > 59) return null;
  let assumedPm = false;
  if (mer) {
    if (hour < 1 || hour > 12) return null;
    if (mer.startsWith('p') && hour !== 12) hour += 12;
    if (mer.startsWith('a') && hour === 12) hour = 0;
  } else {
    if (hour > 23) return null;
    if (hour >= 1 && hour <= 11) { hour += 12; assumedPm = true; }
  }
  const tz = m[4] ? m[4][0].toUpperCase() + 'T' : null;
  return { hour, minute, assumedPm, tz };
}

const DAY_WORDS = {
  sun: 7, sunday: 7, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

// -> { offset } (days from today) or { month, day } or null
function parseDay(text, nowMs, zone = PT) {
  const t = String(text || '').trim().toLowerCase().replace(/[.,]/g, '');
  if (!t || t === 'today' || t === 'tonight') return { offset: 0 };
  if (['tomorrow', 'tmrw', 'tmr', 'tom', 'tomorrow night'].includes(t)) return { offset: 1 };
  if (DAY_WORDS[t]) {
    const today = weekday(nowMs, zone);
    return { offset: (DAY_WORDS[t] - today + 7) % 7, weekdayName: true };
  }
  const md = t.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (md) return { month: Number(md[1]), day: Number(md[2]) };
  return null;
}

function normalizeTz(text) {
  if (!text) return null;
  const t = ` ${String(text).toLowerCase()} `;
  const code = String(text).trim().toUpperCase();
  if (TIMEZONES[code]) return code;
  if (/arizona|phoenix|\baz\b/.test(t)) return 'AZ';
  if (/alaska|\bak[sd]?t\b|anchorage/.test(t)) return 'AK';
  if (/hawaii|\bhst\b|honolulu/.test(t)) return 'HI';
  if (/central|midwest|\bc[sd]?t\b|chicago|texas|dallas|houston/.test(t)) return 'CT';
  if (/eastern|east coast|\be[sd]?t\b|new york|\bny\b|florida|atlanta/.test(t)) return 'ET';
  if (/mountain|\bm[sd]?t\b|denver|utah|colorado/.test(t)) return 'MT';
  if (/pacific|west coast|\bp[sd]?t\b|california|cali\b|\bla\b|seattle|vegas/.test(t)) return 'PT';
  return null;
}

function zoneOf(code) {
  return (TIMEZONES[code] || TIMEZONES.PT).zone;
}

// Turn "Sat" + "8:30 PM" + "ET" into an epoch time.
function resolveGameTime(dayText, clockText, tzCode, nowMs = Date.now()) {
  const clock = parseClock(clockText);
  if (!clock) return { error: `I couldn't read the time "${clockText}". Try something like 8:30 PM.` };
  const zone = zoneOf(clock.tz || tzCode);
  const day = parseDay(dayText, nowMs, zone);
  if (!day) return { error: `I couldn't read the day "${dayText}". Use today, tomorrow, a weekday (Sat), or a date (10/14).` };
  let ms;
  if (day.offset !== undefined) {
    ms = at(nowMs, day.offset, clock.hour, clock.minute, zone);
    if (day.weekdayName && day.offset === 0 && ms <= nowMs) ms = at(nowMs, 7, clock.hour, clock.minute, zone);
  } else {
    const p = parts(nowMs, zone);
    let year = p.year;
    ms = zonedToUtc({ year, month: day.month, day: day.day, hour: clock.hour, minute: clock.minute }, zone);
    if (ms < nowMs - 60 * DAY) {
      year += 1;
      ms = zonedToUtc({ year, month: day.month, day: day.day, hour: clock.hour, minute: clock.minute }, zone);
    }
  }
  return { ms, assumedPm: clock.assumedPm };
}

module.exports = {
  PT, MIN, HOUR, DAY, parts, offset, zonedToUtc, at, startOfDay, weekday, weekStart, dayKey,
  nextAdvanceSlot, rollAdvance, ts, fmtPT, fmtIn, parseClock, parseDay, normalizeTz, zoneOf, resolveGameTime,
};

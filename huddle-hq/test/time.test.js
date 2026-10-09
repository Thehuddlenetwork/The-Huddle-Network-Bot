'use strict';
const test = require('node:test');
const assert = require('node:assert');
const t = require('../src/lib/time');
const { parseMatchupLine, findTeam } = require('../src/lib/teams');
const availability = require('../src/services/availability');

const pt = (iso) => Date.parse(iso); // ISO with offset

test('advance slots: Mon/Wed/Fri 8 PM PT', () => {
  // Thu Oct 8 2026, 6:16 PM PT -> Fri Oct 9 8 PM PT
  const now = pt('2026-10-08T18:16:00-07:00');
  assert.strictEqual(t.nextAdvanceSlot(now), pt('2026-10-09T20:00:00-07:00'));
  // Monday 3 PM, non-strict -> same day 8 PM
  assert.strictEqual(t.nextAdvanceSlot(pt('2026-10-12T15:00:00-07:00')), pt('2026-10-12T20:00:00-07:00'));
  // Monday 8:05 PM after an advance, strict -> Wednesday
  assert.strictEqual(t.nextAdvanceSlot(pt('2026-10-12T20:05:00-07:00'), true), pt('2026-10-14T20:00:00-07:00'));
  // Advance happened early Monday (3 PM), strict -> Wednesday, not tonight
  assert.strictEqual(t.nextAdvanceSlot(pt('2026-10-12T15:00:00-07:00'), true), pt('2026-10-14T20:00:00-07:00'));
  // Friday's advance rolled to Saturday -> next is Monday
  assert.strictEqual(t.nextAdvanceSlot(pt('2026-10-17T20:10:00-07:00'), true), pt('2026-10-19T20:00:00-07:00'));
});

test('rollover keeps 8 PM PT across the DST change', () => {
  // Sat Oct 31 -> Sun Nov 1 (DST ends at 2 AM Nov 1)
  const sat = pt('2026-10-31T20:00:00-07:00');
  assert.strictEqual(t.rollAdvance(sat), pt('2026-11-01T20:00:00-08:00'));
  assert.strictEqual(t.parts(t.rollAdvance(sat)).hour, 20);
});

test('game time parsing', () => {
  const now = pt('2026-10-08T18:16:00-07:00'); // Thursday
  assert.strictEqual(t.resolveGameTime('today', '8:30 PM', 'PT', now).ms, pt('2026-10-08T20:30:00-07:00'));
  assert.strictEqual(t.resolveGameTime('today', '8:30', 'PT', now).ms, pt('2026-10-08T20:30:00-07:00'), 'no AM/PM assumes PM');
  assert.strictEqual(t.resolveGameTime('tomorrow', '9pm', 'ET', now).ms, pt('2026-10-09T21:00:00-04:00'));
  assert.strictEqual(t.resolveGameTime('sat', '7:00 PM', 'CT', now).ms, pt('2026-10-10T19:00:00-05:00'));
  assert.strictEqual(t.resolveGameTime('thu', '5 PM', 'PT', now).ms, pt('2026-10-15T17:00:00-07:00'), 'weekday already passed today -> next week');
  assert.strictEqual(t.resolveGameTime('10/14', '830pm', 'PT', now).ms, pt('2026-10-14T20:30:00-07:00'));
  assert.strictEqual(t.resolveGameTime('today', '9:15 PM ET', 'PT', now).ms, pt('2026-10-08T21:15:00-04:00'), 'zone in the time wins');
  assert.ok(t.resolveGameTime('someday', '8 PM', 'PT', now).error);
  assert.ok(t.resolveGameTime('today', '25:00', 'PT', now).error);
});

test('time zone normalising', () => {
  assert.strictEqual(t.normalizeTz('Eastern'), 'ET');
  assert.strictEqual(t.normalizeTz('pst'), 'PT');
  assert.strictEqual(t.normalizeTz('CST'), 'CT');
  assert.strictEqual(t.normalizeTz('midwest'), 'CT');
  assert.strictEqual(t.normalizeTz('Arizona'), 'AZ');
  assert.strictEqual(t.normalizeTz('west coast'), 'PT');
  assert.strictEqual(t.normalizeTz('banana'), null);
});

test('week start is Monday midnight PT', () => {
  assert.strictEqual(t.weekStart(pt('2026-10-08T18:16:00-07:00')), pt('2026-10-05T00:00:00-07:00'));
  assert.strictEqual(t.weekStart(pt('2026-10-11T23:59:00-07:00')), pt('2026-10-05T00:00:00-07:00'));
});

test('team and matchup parsing', () => {
  assert.deepStrictEqual(parseMatchupLine('Raiders @ Chiefs'), { away: 'Raiders', home: 'Chiefs' });
  assert.deepStrictEqual(parseMatchupLine('LV at KC'), { away: 'Raiders', home: 'Chiefs' });
  assert.deepStrictEqual(parseMatchupLine('1. 49ers vs Rams'), { away: '49ers', home: 'Rams' });
  assert.deepStrictEqual(parseMatchupLine('- Green Bay Packers @ Chicago Bears'), { away: 'Packers', home: 'Bears' });
  assert.deepStrictEqual(parseMatchupLine('Niners@Seahawks'), { away: '49ers', home: 'Seahawks' });
  assert.ok(parseMatchupLine('Raiders @ Raiders').error);
  assert.ok(parseMatchupLine('Raiders @ Unicorns').error);
  assert.strictEqual(findTeam('bucs').name, 'Buccaneers');
  assert.strictEqual(findTeam('New York'), null, 'shared city is ambiguous');
});

test('Game Scheduler finds overlapping times', () => {
  const now = pt('2026-10-08T12:00:00-07:00'); // Thu noon PT
  const until = pt('2026-10-09T18:00:00-07:00'); // Fri 6 PM PT (advance 8 PM minus 2h)
  const east = { timezone: 'ET', avail_days: '4,5', avail_windows: 'prime' }; // 8-11 PM ET = 5-8 PM PT
  const west = { timezone: 'PT', avail_days: '4,5', avail_windows: 'evening,prime' }; // 5-11 PM PT
  const r = availability.suggest(east, west, now, until);
  assert.ok(r.slots.length >= 1);
  for (const ms of r.slots) {
    const p = t.parts(ms);
    assert.ok(p.hour >= 17 && p.hour < 19, `slot ${new Date(ms).toISOString()} should be 5-7 PM PT so a 1-hr game fits 8-11 PM ET`);
    assert.ok(ms <= until);
  }
  const none = availability.suggest({ timezone: 'PT', avail_days: '1', avail_windows: 'morning' }, west, now, until);
  assert.strictEqual(none.slots.length, 0);
});

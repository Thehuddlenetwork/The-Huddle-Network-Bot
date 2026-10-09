'use strict';
// In The Stands (members supporting members) and the THN Passport (viewers).
const crypto = require('crypto');
const db = require('../db');
const settings = require('../settings');
const { UserError } = require('../bus');
const credits = require('./credits');
const members = require('./members');
const { PASSPORT_WORDS } = require('../constants');
const { HOUR, parts, zonedToUtc, PT } = require('../lib/time');

function requireMember(userId, who = 'You') {
  const m = members.get(userId);
  if (!m || m.status !== 'active') throw new UserError(`${who} need${who === 'You' ? '' : 's'} to be an approved THN member.`);
  return m;
}

function scout(userId, opponentId) {
  requireMember(userId);
  requireMember(opponentId, 'Your opponent');
  if (userId === opponentId) throw new UserError('Scout someone else.');
  return credits.earn(userId, 'scoutReport', { capKey: 'scoutPerWeek', reason: `Scouting Report on <@${opponentId}>` });
}

function chat(streamerId, chatterIds) {
  requireMember(streamerId);
  const results = [];
  for (const id of [...new Set(chatterIds)]) {
    if (id === streamerId) { results.push({ id, skipped: 'self' }); continue; }
    const m = members.get(id);
    if (!m || m.status !== 'active') { results.push({ id, skipped: 'not a member' }); continue; }
    const r = credits.earn(id, 'activeChat', { capKey: 'chatPerWeek', ref: `chat:${streamerId}:${Date.now()}`, reason: `Active chat in <@${streamerId}>'s stream` });
    results.push({ id, ...r });
  }
  return results;
}

function raid(raiderId, targetId, ref = null) {
  requireMember(raiderId);
  if (raiderId === targetId) throw new UserError('You can\'t raid yourself.');
  requireMember(targetId, 'That streamer');
  return credits.earn(raiderId, 'raid', { capKey: 'raidsPerWeek', ref, unique: !!ref, reason: `Raid to <@${targetId}>` });
}

// ---------- events ----------

function openEvent(name, minutes, creditsValue, by) {
  const r = db.run('INSERT INTO events (name, credits, closes_at, created_by, created_at) VALUES (?,?,?,?,?)',
    name, creditsValue, Date.now() + minutes * 60000, by, Date.now());
  return db.one('SELECT * FROM events WHERE id = ?', r.lastInsertRowid);
}

function eventCheckIn(eventId, userId) {
  const e = db.one('SELECT * FROM events WHERE id = ?', eventId);
  if (!e) throw new UserError('Event not found.');
  if (Date.now() > e.closes_at) throw new UserError('Check-in for this event has closed.');
  const m = members.get(userId);
  if (!m || m.status !== 'active') return { ok: false, notMember: true, event: e };
  const r = credits.award(userId, e.credits, 'event', `Attended ${e.name}`, { ref: `event:${eventId}`, unique: true });
  return { ...r, event: e };
}

// ---------- THN Passport ----------

function newCode(streamerId, hours = 6) {
  const word = PASSPORT_WORDS[crypto.randomInt(PASSPORT_WORDS.length)];
  let code;
  for (let i = 0; i < 20; i++) {
    code = `${word}${crypto.randomInt(10, 100)}`;
    if (!db.one('SELECT code FROM passport_codes WHERE code = ?', code)) break;
  }
  const now = Date.now();
  db.run('UPDATE passport_codes SET expires_at = ? WHERE streamer_id = ? AND expires_at > ?', now, streamerId, now);
  db.run('INSERT INTO passport_codes (code, streamer_id, created_at, expires_at) VALUES (?,?,?,?)', code, streamerId, now, now + hours * HOUR);
  return { code, expiresAt: now + hours * HOUR };
}

function activeCode(streamerId) {
  return db.one('SELECT * FROM passport_codes WHERE streamer_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1', streamerId, Date.now());
}

function monthStart(ms = Date.now()) {
  const p = parts(ms, PT);
  return zonedToUtc({ year: p.year, month: p.month, day: 1 }, PT);
}

function points(viewerId, sinceMs = monthStart()) {
  const r = db.one('SELECT COUNT(*) AS stamps, COUNT(DISTINCT streamer_id) AS channels FROM passport_stamps WHERE viewer_id = ? AND created_at >= ?', viewerId, sinceMs);
  return { stamps: r.stamps, channels: r.channels, points: r.stamps + r.channels * 2 };
}

function lifetime(viewerId) {
  return points(viewerId, 0);
}

function stamp(viewerId, rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = db.one('SELECT * FROM passport_codes WHERE code = ?', code);
  if (!c) throw new UserError('That code isn\'t valid. Check the spelling on stream.');
  if (c.expires_at < Date.now()) throw new UserError('That code has expired. Catch the next one live!');
  if (c.streamer_id === viewerId) throw new UserError('You can\'t stamp your own code.');
  const before = lifetime(viewerId).points;
  const newChannel = !db.one('SELECT 1 AS x FROM passport_stamps WHERE viewer_id = ? AND streamer_id = ?', viewerId, c.streamer_id);
  try {
    db.run('INSERT INTO passport_stamps (viewer_id, code, streamer_id, created_at) VALUES (?,?,?,?)', viewerId, code, c.streamer_id, Date.now());
  } catch {
    throw new UserError('You already stamped this code.');
  }
  const after = lifetime(viewerId).points;
  const roles = [];
  if (before < settings.limit('fanPoints') && after >= settings.limit('fanPoints')) roles.push('fan');
  if (before < settings.limit('superfanPoints') && after >= settings.limit('superfanPoints')) roles.push('superfan');
  return { streamerId: c.streamer_id, newChannel, month: points(viewerId), lifetime: lifetime(viewerId), roles };
}

// Monthly giveaway: weighted by this month's points.
function draw(sinceMs = monthStart()) {
  const rows = db.all(`SELECT viewer_id, COUNT(*) AS stamps, COUNT(DISTINCT streamer_id) AS channels FROM passport_stamps
    WHERE created_at >= ? GROUP BY viewer_id`, sinceMs);
  if (!rows.length) return null;
  const weighted = rows.map((r) => ({ id: r.viewer_id, w: r.stamps + r.channels * 2 }));
  const total = weighted.reduce((a, b) => a + b.w, 0);
  let pick = crypto.randomInt(total);
  for (const r of weighted) { if (pick < r.w) return { winner: r.id, entries: total, players: rows.length, weight: r.w }; pick -= r.w; }
  return null;
}

module.exports = { scout, chat, raid, openEvent, eventCheckIn, newCode, activeCode, stamp, points, lifetime, draw, monthStart };

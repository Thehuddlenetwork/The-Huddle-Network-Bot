'use strict';
const db = require('../db');
const { UserError } = require('../bus');
const { findTeam } = require('../lib/teams');
const { normalizeTz } = require('../lib/time');

const get = (userId) => db.one('SELECT * FROM members WHERE user_id = ?', userId);
const active = () => db.all("SELECT * FROM members WHERE status = 'active' ORDER BY streamer_name COLLATE NOCASE");
const inLeague = (league) => db.all("SELECT * FROM members WHERE status = 'active' AND league = ? ORDER BY team", league);
const byTeam = (league, team) => db.one("SELECT * FROM members WHERE league = ? AND team = ? AND status = 'active'", league, team);
const waitlist = () => db.all("SELECT * FROM members WHERE status IN ('applied','waitlist') ORDER BY applied_at");

function twitchLoginFrom(url) {
  const m = String(url || '').match(/twitch\.tv\/([A-Za-z0-9_]{3,25})/i);
  return m ? m[1].toLowerCase() : null;
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try { return new URL(u).toString(); } catch { return null; }
}

function saveApplication(userId, { streamerName, streamUrl, gamertag, timezone, availability }) {
  const now = Date.now();
  const url = normalizeUrl(streamUrl);
  if (!url) throw new UserError('That stream link doesn\'t look right. Paste the full link to your channel.');
  const tz = normalizeTz(timezone) || 'PT';
  const existing = get(userId);
  if (existing) {
    db.run(`UPDATE members SET streamer_name=?, stream_url=?, twitch_login=?, gamertag=?, timezone=?, availability_note=?, updated_at=?,
      status = CASE WHEN status IN ('declined','removed','alumni') THEN 'applied' ELSE status END,
      applied_at = CASE WHEN status IN ('declined','removed','alumni') THEN ? ELSE applied_at END
      WHERE user_id=?`,
    streamerName, url, twitchLoginFrom(url), gamertag, tz, availability, now, now, userId);
  } else {
    db.run(`INSERT INTO members (user_id, streamer_name, stream_url, twitch_login, gamertag, timezone, availability_note, status, applied_at, updated_at)
      VALUES (?,?,?,?,?,?,?,'applied',?,?)`, userId, streamerName, url, twitchLoginFrom(url), gamertag, tz, availability, now, now);
  }
  return { member: get(userId), isNew: !existing, tzGuessed: !normalizeTz(timezone) };
}

function setStatus(userId, status) {
  const now = Date.now();
  db.run(`UPDATE members SET status = ?, updated_at = ?, joined_at = CASE WHEN ? = 'active' AND joined_at IS NULL THEN ? ELSE joined_at END
    WHERE user_id = ?`, status, now, status, now, userId);
  if (status !== 'active') db.run('UPDATE members SET team = NULL WHERE user_id = ?', userId);
  return get(userId);
}

function approve(userId, league = 'HL') {
  const m = get(userId);
  if (!m) throw new UserError('No application found for that member.');
  db.run('UPDATE members SET league = COALESCE(league, ?) WHERE user_id = ?', league, userId);
  return setStatus(userId, 'active');
}

function assignTeam(userId, league, teamInput) {
  const team = findTeam(teamInput);
  if (!team) throw new UserError(`I don't know the team "${teamInput}".`);
  const m = get(userId);
  if (!m) throw new UserError('That person hasn\'t joined yet. Have them use /join (or the Join button) first.');
  const holder = byTeam(league, team.name);
  if (holder && holder.user_id !== userId) throw new UserError(`The ${team.name} already belong to <@${holder.user_id}>. Remove them first.`);
  db.run(`UPDATE members SET league = ?, team = ?, status = 'active', updated_at = ?,
    joined_at = COALESCE(joined_at, ?) WHERE user_id = ?`, league, team.name, Date.now(), Date.now(), userId);
  return { member: get(userId), team };
}

function unassign(userId) {
  db.run('UPDATE members SET team = NULL, updated_at = ? WHERE user_id = ?', Date.now(), userId);
  return get(userId);
}

function moveLeague(userId, league) {
  db.run('UPDATE members SET league = ?, team = NULL, updated_at = ? WHERE user_id = ?', league, Date.now(), userId);
  return get(userId);
}

function updateStream(userId, url) {
  const u = normalizeUrl(url);
  if (!u) throw new UserError('That link doesn\'t look right.');
  db.run('UPDATE members SET stream_url = ?, twitch_login = ?, updated_at = ? WHERE user_id = ?', u, twitchLoginFrom(u), Date.now(), userId);
  return get(userId);
}

function setAvailability(userId, patch) {
  const m = get(userId);
  if (!m) {
    db.run("INSERT INTO members (user_id, status, applied_at, updated_at) VALUES (?, 'applied', ?, ?)", userId, Date.now(), Date.now());
  }
  if (patch.timezone) db.run('UPDATE members SET timezone = ? WHERE user_id = ?', patch.timezone, userId);
  if (patch.days) db.run('UPDATE members SET avail_days = ? WHERE user_id = ?', patch.days.join(','), userId);
  if (patch.windows) db.run('UPDATE members SET avail_windows = ? WHERE user_id = ?', patch.windows.join(','), userId);
  return get(userId);
}

const name = (m, fallbackId) => (m && m.streamer_name) || (fallbackId ? `<@${fallbackId}>` : 'Member');

// Tier comes from roles that Whop assigns.
function tierFromRoles(roleIds, settings) {
  const pro = settings.roleId('pro');
  const std = settings.roleId('standard');
  if (pro && roleIds.includes(pro)) return 'Pro';
  if (std && roleIds.includes(std)) return 'Standard';
  return 'Free';
}

module.exports = {
  get, active, inLeague, byTeam, waitlist, saveApplication, setStatus, approve, assignTeam, unassign, moveLeague,
  updateStream, setAvailability, name, tierFromRoles, twitchLoginFrom, normalizeUrl,
};

'use strict';
const db = require('./db');
const { CREDITS, LIMITS } = require('./constants');

function get(key, fallback = null) {
  const row = db.one('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

function set(key, value) {
  if (value === null || value === undefined) {
    db.run('DELETE FROM settings WHERE key = ?', key);
  } else {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }
}

function getInt(key, fallback = 0) {
  const v = get(key);
  if (v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const channelId = (purpose) => get(`channel:${purpose}`);
const roleId = (purpose) => get(`role:${purpose}`);
const season = () => getInt('season', 1);
const week = (league) => getInt(`week:${league}`, 0);
const credit = (key) => getInt(`credit:${key}`, CREDITS[key] ? CREDITS[key][0] : 0);
const limit = (key) => getInt(`limit:${key}`, LIMITS[key] ? LIMITS[key][0] : 0);

// Leagues that are running (Network League forms after Season 1).
function activeLeagues() {
  const raw = get('leagues', 'HL');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { get, set, getInt, channelId, roleId, season, week, credit, limit, activeLeagues };

'use strict';
const db = require('../db');
const settings = require('../settings');
const { bus } = require('../bus');
const { CREDITS } = require('../constants');
const { weekStart } = require('../lib/time');

const balance = (userId) => (db.one('SELECT COALESCE(SUM(amount),0) AS b FROM ledger WHERE user_id = ?', userId) || {}).b || 0;

function weeklyCount(userId, category, nowMs = Date.now()) {
  return db.one('SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND category = ? AND amount > 0 AND created_at >= ?',
    userId, category, weekStart(nowMs)).n;
}

function hasRef(userId, category, ref) {
  return !!db.one('SELECT id FROM ledger WHERE user_id = ? AND category = ? AND ref = ?', userId, category, ref);
}

// Core write. Options: ref, by, unique (skip if same user+category+ref exists), capKey (weekly LIMITS key)
function award(userId, amount, category, reason, opts = {}) {
  const { ref = null, by = null, unique = false, capKey = null } = opts;
  if (!userId || !amount) return { ok: false, zero: true };
  if (unique && ref && hasRef(userId, category, ref)) return { ok: false, dup: true };
  if (capKey && amount > 0) {
    const cap = settings.limit(capKey);
    if (weeklyCount(userId, category) >= cap) return { ok: false, capped: true, cap };
  }
  db.run('INSERT INTO ledger (user_id, amount, category, reason, ref, by_user, created_at) VALUES (?,?,?,?,?,?,?)',
    userId, amount, category, reason, ref, by, Date.now());
  const bal = balance(userId);
  bus.emit('credit', { userId, amount, category, reason, balance: bal, by });
  return { ok: true, amount, balance: bal };
}

// Pay a standard rule from CREDITS by key, at its current value.
function earn(userId, key, opts = {}) {
  const amount = settings.credit(key);
  const reason = opts.reason || (CREDITS[key] ? CREDITS[key][1] : key);
  return award(userId, amount, key, reason, opts);
}

function spend(userId, amount, category, reason, opts = {}) {
  if (balance(userId) < amount) return { ok: false, short: amount - balance(userId) };
  return award(userId, -Math.abs(amount), category, reason, opts);
}

function history(userId, limit = 10) {
  return db.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit);
}

function leaderboard(limit = 10, sinceMs = 0) {
  return db.all(`SELECT l.user_id, SUM(l.amount) AS total, m.streamer_name FROM ledger l
    LEFT JOIN members m ON m.user_id = l.user_id WHERE l.created_at >= ? AND l.amount > 0
    GROUP BY l.user_id ORDER BY total DESC LIMIT ?`, sinceMs, limit);
}

function earnedSince(userId, sinceMs) {
  return db.one('SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE user_id = ? AND amount > 0 AND created_at >= ?', userId, sinceMs).t;
}

module.exports = { balance, weeklyCount, hasRef, award, earn, spend, history, leaderboard, earnedSince };

'use strict';
const db = require('../db');
const settings = require('../settings');
const { bus } = require('../bus');

const KIND_LABEL = {
  late: 'Late kickoff (16 to 30 min)',
  late30: 'Late kickoff (30+ min)',
  noshow: 'No-show',
  ragequit: 'Rage quit',
  unplayed: 'Unplayed game',
  conduct: 'Conduct',
  stream: 'Streaming rule',
  other: 'Other',
};

function count(userId, season = settings.season(), kind = null) {
  if (kind) return db.one('SELECT COUNT(*) AS n FROM strikes WHERE user_id=? AND season=? AND kind=? AND voided=0', userId, season, kind).n;
  return db.one('SELECT COUNT(*) AS n FROM strikes WHERE user_id=? AND season=? AND voided=0', userId, season).n;
}

const list = (userId, season = settings.season()) =>
  db.all('SELECT * FROM strikes WHERE user_id=? AND season=? ORDER BY id DESC', userId, season);

function flagReview(userId, reason) {
  const open = db.one("SELECT id FROM reviews WHERE user_id=? AND status='open' AND reason=?", userId, reason);
  if (open) return null;
  const r = db.run("INSERT INTO reviews (user_id, reason, status, created_at) VALUES (?,?,'open',?)", userId, reason, Date.now());
  bus.emit('review', { id: r.lastInsertRowid, userId, reason });
  return r.lastInsertRowid;
}

function add(userId, kind, reason, { gameId = null, by = null } = {}) {
  const season = settings.season();
  const r = db.run('INSERT INTO strikes (user_id, season, kind, reason, game_id, issued_by, created_at) VALUES (?,?,?,?,?,?,?)',
    userId, season, kind, reason, gameId, by, Date.now());
  const total = count(userId, season);
  const id = r.lastInsertRowid;
  bus.emit('strike', { id, userId, kind, label: KIND_LABEL[kind] || kind, reason, total, gameId, by });

  if (total === settings.limit('strikesFreeze')) bus.emit('freeze', { userId, total });
  if (total >= settings.limit('strikesReview')) flagReview(userId, `${total} strikes this season`);
  if (kind === 'noshow' && count(userId, season, 'noshow') >= settings.limit('noShowsReview')) flagReview(userId, 'Repeated no-shows');
  if (kind === 'ragequit' && count(userId, season, 'ragequit') >= settings.limit('rageQuitsReview')) flagReview(userId, 'Repeated rage quits');
  return { id, total };
}

function voidStrike(id, by) {
  const s = db.one('SELECT * FROM strikes WHERE id = ?', id);
  if (!s) return null;
  db.run('UPDATE strikes SET voided = 1 WHERE id = ?', id);
  bus.emit('strikeVoid', { ...s, by, total: count(s.user_id, s.season) });
  return s;
}

function isFrozen(userId) {
  const m = db.one('SELECT trade_unfrozen_season FROM members WHERE user_id = ?', userId);
  if (m && m.trade_unfrozen_season === settings.season()) return false;
  return count(userId) >= settings.limit('strikesFreeze');
}

module.exports = { KIND_LABEL, count, list, add, voidStrike, isFrozen, flagReview };

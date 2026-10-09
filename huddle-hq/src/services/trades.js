'use strict';
// The Trade Desk: proposal with a WHY from each side, 3-person committee, auto-pass after 24 hrs.
const db = require('../db');
const settings = require('../settings');
const { UserError, bus } = require('../bus');
const members = require('./members');
const strikes = require('./strikes');
const { HOUR } = require('../lib/time');

const get = (id) => db.one('SELECT * FROM trades WHERE id = ?', id);
const votes = (id) => db.all('SELECT * FROM trade_votes WHERE trade_id = ?', id);

function deadlineOk(league) {
  const dl = settings.getInt(`trade_deadline:${league}`, 0);
  return !dl || settings.week(league) <= dl;
}

function propose(fromId, toId, { sending, receiving, why }) {
  if (fromId === toId) throw new UserError('You can\'t trade with yourself.');
  const a = members.get(fromId);
  const b = members.get(toId);
  if (!a || a.status !== 'active' || !a.team) throw new UserError('You need an assigned team to trade.');
  if (!b || b.status !== 'active' || !b.team) throw new UserError('That member doesn\'t have an assigned team.');
  if (a.league !== b.league) throw new UserError('Trades have to be within the same league.');
  if (!deadlineOk(a.league)) throw new UserError('The trade deadline has passed for this season.');
  if (strikes.isFrozen(fromId)) throw new UserError('Your trades are frozen (3+ strikes) until staff reviews your account.');
  if (strikes.isFrozen(toId)) throw new UserError('That member\'s trades are frozen until staff reviews their account.');
  const r = db.run(`INSERT INTO trades (season, league, week, from_user, to_user, from_team, to_team, sending, receiving, why_from, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pending_partner',?)`, settings.season(), a.league, settings.week(a.league), fromId, toId, a.team, b.team,
  sending, receiving, why, Date.now());
  return get(r.lastInsertRowid);
}

function accept(id, userId, why) {
  const t = get(id);
  if (!t) throw new UserError('Trade not found.');
  if (t.to_user !== userId) throw new UserError('Only the other team can accept this trade.');
  if (t.status !== 'pending_partner') throw new UserError('This trade is no longer waiting on you.');
  if (strikes.isFrozen(userId)) throw new UserError('Your trades are frozen until staff reviews your account.');
  db.run("UPDATE trades SET why_to = ?, status = 'voting', voting_at = ? WHERE id = ?", why, Date.now(), id);
  return get(id);
}

function decline(id, userId, { staff = false } = {}) {
  const t = get(id);
  if (!t) throw new UserError('Trade not found.');
  const allowed = staff || t.to_user === userId || t.from_user === userId;
  if (!allowed) throw new UserError('Only the two teams can call off this trade.');
  if (!['pending_partner', 'voting'].includes(t.status)) throw new UserError('This trade is already decided.');
  const status = t.from_user === userId ? 'cancelled' : 'declined';
  db.run('UPDATE trades SET status = ?, decided_at = ? WHERE id = ?', status, Date.now(), id);
  return get(id);
}

function tally(id) {
  const v = votes(id);
  return { yes: v.filter((x) => x.vote === 'yes').length, no: v.filter((x) => x.vote === 'no').length, voters: v };
}

function decide(id, status) {
  db.run('UPDATE trades SET status = ?, decided_at = ? WHERE id = ?', status, Date.now(), id);
  const t = get(id);
  bus.emit('tradeDecided', t);
  return t;
}

function vote(id, userId, value) {
  const t = get(id);
  if (!t) throw new UserError('Trade not found.');
  if (t.status !== 'voting') throw new UserError('Voting on this trade is closed.');
  if (t.from_user === userId || t.to_user === userId) throw new UserError('You can\'t vote on your own trade.');
  db.run(`INSERT INTO trade_votes (trade_id, voter_id, vote, created_at) VALUES (?,?,?,?)
    ON CONFLICT(trade_id, voter_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`, id, userId, value, Date.now());
  const c = tally(id);
  if (c.yes >= 2) return { trade: decide(id, 'approved'), ...c };
  if (c.no >= 2) return { trade: decide(id, 'rejected'), ...c };
  return { trade: get(id), ...c };
}

// No majority after the window -> passes, so deals never sit in limbo.
function expireDue(now = Date.now()) {
  const due = db.all("SELECT * FROM trades WHERE status = 'voting' AND voting_at <= ?", now - settings.limit('tradeVoteHours') * HOUR);
  return due.map((t) => {
    const c = tally(t.id);
    return { trade: decide(t.id, c.no >= 2 ? 'rejected' : 'approved'), auto: true, ...c };
  });
}

function setMessage(id, kind, channelId, messageId) {
  const cols = { desk: ['desk_channel', 'desk_message'], vote: ['vote_channel', 'vote_message'], wire: ['wire_channel', 'wire_message'] }[kind];
  db.run(`UPDATE trades SET ${cols[0]} = ?, ${cols[1]} = ? WHERE id = ?`, channelId, messageId, id);
}

function grade(id, side, value) {
  const col = side === 'from' ? 'grade_from' : 'grade_to';
  db.run(`UPDATE trades SET ${col} = ? WHERE id = ?`, value, id);
  return get(id);
}

const recent = (limit = 10) => db.all('SELECT * FROM trades ORDER BY id DESC LIMIT ?', limit);
const forUser = (userId, limit = 10) => db.all('SELECT * FROM trades WHERE from_user = ? OR to_user = ? ORDER BY id DESC LIMIT ?', userId, userId, limit);

module.exports = { get, votes, propose, accept, decline, vote, tally, expireDue, setMessage, grade, recent, forUser, deadlineOk };

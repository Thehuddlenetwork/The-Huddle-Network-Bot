'use strict';
// The Huddle Academy: levels worked in order, each unlocked by an approved check-in.
const db = require('../db');
const { UserError } = require('../bus');
const credits = require('./credits');
const members = require('./members');
const { ACADEMY_LEVELS } = require('../constants');

const get = (id) => db.one('SELECT * FROM academy_submissions WHERE id = ?', id);
const levelName = (n) => (n >= 1 && n <= ACADEMY_LEVELS.length ? `L${n} ${ACADEMY_LEVELS[n - 1].name}` : 'Not started');

function current(userId) {
  const m = members.get(userId);
  return (m && m.academy_level) || 0;
}

function submit(userId, { proof, notes }) {
  const done = current(userId);
  if (done >= ACADEMY_LEVELS.length) throw new UserError('You\'ve completed every Academy level. Legend.');
  const level = done + 1;
  const open = db.one("SELECT id FROM academy_submissions WHERE user_id = ? AND level = ? AND status = 'pending'", userId, level);
  if (open) throw new UserError(`Your Level ${level} check-in is already with a coach (#${open.id}).`);
  if (!members.get(userId)) db.run("INSERT INTO members (user_id, status, applied_at, updated_at) VALUES (?, 'applied', ?, ?)", userId, Date.now(), Date.now());
  const r = db.run("INSERT INTO academy_submissions (user_id, level, proof, notes, status, created_at) VALUES (?,?,?,?,'pending',?)",
    userId, level, proof, notes, Date.now());
  return get(r.lastInsertRowid);
}

function setMessage(id, channelId, messageId) {
  db.run('UPDATE academy_submissions SET channel_id = ?, message_id = ? WHERE id = ?', channelId, messageId, id);
}

function approve(id, by) {
  const s = get(id);
  if (!s) throw new UserError('Check-in not found.');
  if (s.status !== 'pending') throw new UserError(`This check-in was already ${s.status}.`);
  db.tx(() => {
    db.run("UPDATE academy_submissions SET status = 'approved', reviewed_by = ? WHERE id = ?", by, id);
    db.run('UPDATE members SET academy_level = MAX(COALESCE(academy_level,0), ?) WHERE user_id = ?', s.level, s.user_id);
  });
  const r = credits.earn(s.user_id, 'academyLevel', { ref: `academy:${s.level}`, unique: true, by, reason: `Academy ${levelName(s.level)} complete` });
  return { submission: get(id), level: s.level, paid: r.ok ? r.amount : 0, finished: s.level >= ACADEMY_LEVELS.length };
}

function sendBack(id, by, feedback) {
  const s = get(id);
  if (!s) throw new UserError('Check-in not found.');
  if (s.status !== 'pending') throw new UserError(`This check-in was already ${s.status}.`);
  db.run("UPDATE academy_submissions SET status = 'needs_work', reviewed_by = ?, feedback = ? WHERE id = ?", by, feedback, id);
  return get(id);
}

const pending = () => db.all("SELECT * FROM academy_submissions WHERE status = 'pending' ORDER BY id");

module.exports = { get, levelName, current, submit, setMessage, approve, sendBack, pending };

'use strict';
// The Highlight Reel: submit -> review -> feature -> view milestones -> Clip of the Week.
const db = require('../db');
const settings = require('../settings');
const { UserError, bus } = require('../bus');
const credits = require('./credits');
const games = require('./games');
const { weekStart, HOUR } = require('../lib/time');

const get = (id) => db.one('SELECT * FROM clips WHERE id = ?', id);

function submit(userId, { url, type, vertical, note }) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).toString(); } catch { throw new UserError('That clip link doesn\'t look right.'); }
  // Link to the member's most recent game in the last 48 hours, if any.
  const recent = db.one(`SELECT g.id FROM games g JOIN game_players p ON p.game_id = g.id
    WHERE p.user_id = ? AND (g.kickoff_at >= ? OR g.completed_at >= ?) ORDER BY g.id DESC LIMIT 1`, userId, Date.now() - 48 * HOUR, Date.now() - 48 * HOUR);
  const r = db.run('INSERT INTO clips (user_id, url, type, game_id, vertical, note, status, created_at) VALUES (?,?,?,?,?,?,\'pending\',?)',
    userId, u, type, recent ? recent.id : null, vertical ? 1 : 0, note, Date.now());
  return get(r.lastInsertRowid);
}

function setMessage(id, channelId, messageId) {
  db.run('UPDATE clips SET channel_id = ?, message_id = ? WHERE id = ?', channelId, messageId, id);
}

function creditedThisWeek(userId) {
  return db.one('SELECT COUNT(*) AS n FROM clips WHERE user_id = ? AND credited = 1 AND created_at >= ?', userId, weekStart(Date.now())).n;
}

function accept(id, by) {
  const c = get(id);
  if (!c) throw new UserError('Clip not found.');
  if (c.status !== 'pending') throw new UserError(`This clip was already ${c.status}.`);
  const paid = [];
  let capped = false;
  if (creditedThisWeek(c.user_id) < settings.limit('clipsPerWeek')) {
    const r1 = credits.earn(c.user_id, 'clipAccepted', { ref: `clip:${id}`, unique: true, by, reason: `Clip accepted (#${id})` });
    if (r1.ok) paid.push(r1.amount);
    if (c.vertical) {
      const r2 = credits.earn(c.user_id, 'clipVertical', { ref: `clip:${id}`, unique: true, by, reason: `Vertical clip (#${id})` });
      if (r2.ok) paid.push(r2.amount);
    }
    db.run('UPDATE clips SET credited = 1 WHERE id = ?', id);
  } else capped = true;
  db.run("UPDATE clips SET status = 'accepted', reviewed_by = ? WHERE id = ?", by, id);
  return { clip: get(id), paid: paid.reduce((a, b) => a + b, 0), capped };
}

function decline(id, by) {
  const c = get(id);
  if (!c) throw new UserError('Clip not found.');
  db.run("UPDATE clips SET status = 'declined', reviewed_by = ? WHERE id = ?", by, id);
  return get(id);
}

function feature(id, by) {
  const c = get(id);
  if (!c) throw new UserError('Clip not found.');
  if (c.status === 'pending') accept(id, by);
  if (c.featured) throw new UserError('This clip is already featured.');
  db.run("UPDATE clips SET featured = 1, status = 'featured' WHERE id = ?", id);
  const r = credits.earn(c.user_id, 'clipFeatured', { ref: `clip:${id}`, unique: true, by, reason: `Clip featured on THN (#${id})` });
  bus.emit('clipFeatured', get(id));
  return { clip: get(id), paid: r.ok ? r.amount : 0 };
}

const MILESTONES = [['1k', 'clip1k'], ['10k', 'clip10k'], ['100k', 'clip100k']];

// Paying 10K also pays 1K if it wasn't paid yet.
function milestone(id, level, by) {
  const c = get(id);
  if (!c) throw new UserError('Clip not found.');
  const idx = MILESTONES.findIndex(([k]) => k === level);
  let marks = c.milestones || '';
  let total = 0;
  for (let i = 0; i <= idx; i++) {
    const [k, key] = MILESTONES[i];
    if (marks.split(',').includes(k)) continue;
    const r = credits.earn(c.user_id, key, { ref: `clip:${id}`, unique: true, by, reason: `Clip #${id} hit ${k.toUpperCase()} views` });
    if (r.ok) total += r.amount;
    marks += `${k},`;
  }
  db.run('UPDATE clips SET milestones = ? WHERE id = ?', marks, id);
  return { clip: get(id), paid: total };
}

const byUser = (userId, limit = 10) => db.all('SELECT * FROM clips WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit);
const pending = () => db.all("SELECT * FROM clips WHERE status = 'pending' ORDER BY id");
const thisWeek = (sinceMs) => db.all("SELECT * FROM clips WHERE status IN ('accepted','featured') AND created_at >= ? ORDER BY featured DESC, id DESC", sinceMs);

// ---------- Clip of the Week ----------

function openPoll(clipIds, closesAt) {
  const ids = [...new Set(clipIds)].slice(0, 5);
  if (ids.length < 2) throw new UserError('Pick at least 2 clips for the vote.');
  for (const id of ids) {
    const c = get(id);
    if (!c) throw new UserError(`Clip #${id} doesn't exist.`);
    if (c.status === 'declined' || c.status === 'pending') throw new UserError(`Clip #${id} hasn't been accepted.`);
  }
  const r = db.run("INSERT INTO clip_polls (clip_ids, status, closes_at, created_at) VALUES (?, 'open', ?, ?)", ids.join(','), closesAt, Date.now());
  return getPoll(r.lastInsertRowid);
}

function getPoll(id) {
  const p = db.one('SELECT * FROM clip_polls WHERE id = ?', id);
  if (!p) return null;
  return { ...p, clips: p.clip_ids.split(',').map(Number).map(get).filter(Boolean) };
}

function setPollMessage(id, channelId, messageId) {
  db.run('UPDATE clip_polls SET channel_id = ?, message_id = ? WHERE id = ?', channelId, messageId, id);
}

function pollCounts(id) {
  const out = {};
  for (const r of db.all('SELECT clip_id, COUNT(*) AS n FROM clip_votes WHERE poll_id = ? GROUP BY clip_id', id)) out[r.clip_id] = r.n;
  return out;
}

function votePoll(pollId, voterId, clipId) {
  const p = getPoll(pollId);
  if (!p || p.status !== 'open') throw new UserError('This vote is closed.');
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) throw new UserError('That clip isn\'t in this vote.');
  if (c.user_id === voterId) throw new UserError('You can\'t vote for your own clip.');
  db.run(`INSERT INTO clip_votes (poll_id, voter_id, clip_id) VALUES (?,?,?)
    ON CONFLICT(poll_id, voter_id) DO UPDATE SET clip_id = excluded.clip_id`, pollId, voterId, clipId);
  return pollCounts(pollId);
}

function closePoll(pollId, by = null) {
  const p = getPoll(pollId);
  if (!p || p.status !== 'open') throw new UserError('That vote is not open.');
  const counts = pollCounts(pollId);
  const ranked = p.clips.slice().sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || a.id - b.id);
  const winner = ranked[0];
  db.run("UPDATE clip_polls SET status = 'closed', winner_clip = ? WHERE id = ?", winner.id, pollId);
  const r = credits.earn(winner.user_id, 'clipOfWeek', { ref: `cotw:${pollId}`, unique: true, by, reason: `Clip of the Week (#${winner.id})` });
  return { poll: getPoll(pollId), winner, votes: counts[winner.id] || 0, counts, paid: r.ok ? r.amount : 0 };
}

const openPolls = () => db.all("SELECT * FROM clip_polls WHERE status = 'open'");

module.exports = {
  get, submit, setMessage, accept, decline, feature, milestone, byUser, pending, thisWeek,
  openPoll, getPoll, setPollMessage, pollCounts, votePoll, closePoll, openPolls, gameLabel: games.label,
};

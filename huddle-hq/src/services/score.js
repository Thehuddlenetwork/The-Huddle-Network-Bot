'use strict';
// Huddle Creator Score: an OVR rating from Streaming, Social, Presentation, Community and Growth.
const db = require('../db');
const settings = require('../settings');
const games = require('./games');
const strikes = require('./strikes');
const members = require('./members');

const CATEGORIES = {
  streaming: { label: 'Streaming', weight: 0.25, source: 'On-time and completion rates, minus strikes' },
  social: { label: 'Social', weight: 0.20, source: 'Clips accepted, featured and view milestones' },
  presentation: { label: 'Presentation', weight: 0.20, source: 'Staff stream audit (set with /hq score-rate)' },
  community: { label: 'Community', weight: 0.20, source: 'Scouting Reports, active chat, raids, events' },
  growth: { label: 'Growth', weight: 0.15, source: 'Academy progress, or staff rating' },
};

const clamp = (v) => Math.max(40, Math.min(99, Math.round(v)));

function ratings(userId) {
  const out = {};
  for (const r of db.all('SELECT category, value FROM score_ratings WHERE user_id = ?', userId)) out[r.category] = r.value;
  return out;
}

function setRating(userId, category, value) {
  if (value === null || value === undefined) db.run('DELETE FROM score_ratings WHERE user_id = ? AND category = ?', userId, category);
  else db.run(`INSERT INTO score_ratings (user_id, category, value, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id, category) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, userId, category, value, Date.now());
}

function compute(userId) {
  const season = settings.season();
  const since = settings.getInt('season_started_at', 0);
  const st = games.memberStats(userId, season);
  const strikeCount = strikes.count(userId, season);
  const m = members.get(userId) || {};
  const clips = db.one(`SELECT
      SUM(CASE WHEN status IN ('accepted','featured') THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN featured = 1 THEN 1 ELSE 0 END) AS featured,
      SUM(LENGTH(milestones) - LENGTH(REPLACE(milestones, ',', ''))) AS milestones
    FROM clips WHERE user_id = ? AND created_at >= ?`, userId, since) || {};
  const community = db.one(`SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND amount > 0 AND created_at >= ?
      AND category IN ('scoutReport','activeChat','raid','event')`, userId, since).n;

  const auto = {};
  if (st.timed + st.counted === 0) auto.streaming = 60;
  else {
    const ot = st.onTimeRate === null ? 0.8 : st.onTimeRate;
    const cr = st.completeRate === null ? 0.8 : st.completeRate;
    auto.streaming = clamp(50 + 49 * (0.5 * ot + 0.5 * cr) - strikeCount * 3);
  }
  auto.social = clamp(55 + Math.min(44, (clips.accepted || 0) * 2 + (clips.featured || 0) * 5 + (clips.milestones || 0) * 3));
  auto.presentation = 60;
  auto.community = clamp(55 + Math.min(44, community * 3));
  auto.growth = clamp(55 + (m.academy_level || 0) * 5);

  const manual = ratings(userId);
  const cats = {};
  let ovr = 0;
  for (const [key, c] of Object.entries(CATEGORIES)) {
    const value = manual[key] !== undefined ? manual[key] : auto[key];
    cats[key] = { ...c, value, manual: manual[key] !== undefined };
    ovr += value * c.weight;
  }
  return { ovr: Math.round(ovr), categories: cats, stats: st, strikes: strikeCount };
}

function leaderboard(league = null, limit = 15) {
  const list = (league ? members.inLeague(league) : members.active()).map((m) => ({ member: m, ...compute(m.user_id) }));
  return list.sort((a, b) => b.ovr - a.ovr).slice(0, limit);
}

module.exports = { CATEGORIES, compute, ratings, setRating, leaderboard };

'use strict';
const db = require('../db');
const settings = require('../settings');
const games = require('../services/games');
const members = require('../services/members');
const ui = require('../lib/ui');
const { ts, at, HOUR } = require('../lib/time');
const { BRAND, LEAGUES } = require('../constants');

function gameLine(g) {
  const name = `**${g.away_team} @ ${g.home_team}**`;
  const star = g.gotw ? ' ⭐' : '';
  switch (g.status) {
    case 'locked': return `🔒 ${name}${star} · ${ts(g.locked_at, 'f')}`;
    case 'scheduled': return `⏳ ${name}${star} · not locked`;
    case 'kicked': return `🏈 ${name}${star} · live now`;
    case 'final_pending': return `📝 ${name} · ${g.away_score}-${g.home_score} (confirming)`;
    case 'complete': return `✅ ${name} · ${g.away_score}-${g.home_score}`;
    case 'cpu': return `🤖 ${name} · CPU`;
    case 'unplayed': return `⛔ ${name} · unplayed`;
    default: return `⚖️ ${name} · ${g.status.replace('_', ' ')}`;
  }
}

function scheduleEmbed(league, week) {
  const list = games.weekGames(league, week);
  const next = games.nextAdvance();
  const desc = list.length ? list.map(gameLine).join('\n') : 'No matchups imported for this week yet.';
  const counts = list.reduce((acc, g) => { acc[g.status] = (acc[g.status] || 0) + 1; return acc; }, {});
  const done = (counts.complete || 0) + (counts.forfeit || 0) + (counts.forcewin || 0) + (counts.sim || 0) + (counts.double_loss || 0);
  return ui.embed({
    title: `${LEAGUES[league].toUpperCase()}  |  WEEK ${week}`,
    description: `${desc}${next ? `\n\nNext advance: ${ts(next, 'F')} (${ts(next, 'R')})` : ''}`,
    footer: `${done}/${list.filter((g) => g.status !== 'cpu').length} games final · ${counts.locked || 0} locked`,
    color: BRAND.black,
  });
}

// Locked games kicking off between now-3h and 4 AM PT tomorrow.
function tonightGames(now = Date.now()) {
  const end = at(now, 1, 4, 0);
  return db.all(`SELECT * FROM games WHERE season = ? AND status IN ('locked','kicked') AND locked_at BETWEEN ? AND ?
    ORDER BY locked_at`, settings.season(), now - 3 * HOUR, end);
}

function streamLink(gameId, side) {
  const p = games.getPlayer(gameId, side);
  if (!p) return null;
  const m = members.get(p.user_id);
  const url = p.stream_url || (m && m.stream_url);
  const name = (m && m.streamer_name) || 'stream';
  return url ? `[${name}](${url})` : name;
}

function tonightEmbed(now = Date.now()) {
  const list = tonightGames(now);
  if (!list.length) return null;
  const lines = list.map((g) => {
    const head = `${ts(g.locked_at, 't')}  **${g.away_team} @ ${g.home_team}**${g.gotw ? '  ⭐ GAME OF THE WEEK' : ''}`;
    const streams = [streamLink(g.id, 'away'), streamLink(g.id, 'home')].filter(Boolean).join('  vs  ');
    return `${head}\n${g.league} WK ${g.week} · ${streams}`;
  });
  return ui.embed({ title: 'TONIGHT ON THN', description: lines.join('\n\n'), footer: 'Every game streamed live', color: BRAND.red, timestamp: true });
}

module.exports = { gameLine, scheduleEmbed, tonightGames, tonightEmbed };

'use strict';
const db = require('../db');
const settings = require('../settings');
const { UserError } = require('../bus');
const games = require('./games');
const members = require('./members');
const credits = require('./credits');
const { nextAdvanceSlot, rollAdvance } = require('../lib/time');
const { findTeam } = require('../lib/teams');

function ensureClock(now = Date.now()) {
  if (!settings.getInt('next_advance_at', 0)) settings.set('next_advance_at', nextAdvanceSlot(now, false));
  return settings.getInt('next_advance_at');
}

function leaguesInUse() {
  const list = settings.activeLeagues();
  return list.length ? list : ['HL'];
}

// Close the current week and move each league forward.
function advance({ leagues = leaguesInUse(), toWeek = null } = {}) {
  const now = Date.now();
  const results = [];
  for (const league of leagues) {
    const cur = settings.week(league);
    const closing = cur > 0 ? games.closeWeek(league, cur) : { unplayed: [], bonuses: [] };
    const next = toWeek !== null && toWeek !== undefined ? toWeek : cur + 1;
    settings.set(`week:${league}`, next);
    settings.set(`advanced_at:${league}`, now);
    db.run('UPDATE games SET advance_at = ? WHERE season = ? AND league = ? AND week = ? AND advance_at IS NULL', now, settings.season(), league, next);
    games.refreshWeekOwners(league, next);
    results.push({ league, from: cur, to: next, ...closing, games: games.weekGames(league, next) });
  }
  settings.set('next_advance_at', nextAdvanceSlot(now, true));
  settings.set('last_advance_at', now);
  return results;
}

// Flex-day rule: a missed advance moves to the next day at 8 PM PT.
function delayAdvance() {
  const cur = ensureClock();
  const next = rollAdvance(cur);
  settings.set('next_advance_at', next);
  return next;
}

function setNextAdvance(ms) {
  settings.set('next_advance_at', ms);
  return ms;
}

function startSeason(number) {
  const prev = settings.season();
  const payouts = [];
  const value = settings.credit('unusedAudible');
  if (value > 0 && number !== prev) {
    for (const m of members.active()) {
      const used = db.one('SELECT COUNT(*) AS n FROM audibles WHERE user_id = ? AND season = ? AND late = 0', m.user_id, prev).n;
      const unused = Math.max(0, settings.limit('audiblesPerSeason') - used);
      if (unused > 0) {
        const r = credits.award(m.user_id, unused * value, 'unusedAudible', `${unused} unused Audible(s), Season ${prev}`, { ref: `audibles:${prev}`, unique: true });
        if (r.ok) payouts.push({ userId: m.user_id, amount: r.amount });
      }
    }
  }
  settings.set('season', number);
  settings.set('season_started_at', Date.now());
  for (const l of ['HL', 'NL']) { settings.set(`week:${l}`, 0); settings.set(`advanced_at:${l}`, null); }
  db.run('UPDATE members SET ontime_streak = 0, complete_streak = 0');
  return { season: number, payouts };
}

function eliminate(league, teamInput, undo = false) {
  const team = findTeam(teamInput);
  if (!team) throw new UserError(`Unknown team "${teamInput}".`);
  const season = settings.season();
  if (undo) db.run('DELETE FROM eliminations WHERE season = ? AND league = ? AND team = ?', season, league, team.name);
  else db.run('INSERT OR REPLACE INTO eliminations (season, league, team, week) VALUES (?,?,?,?)', season, league, team.name, settings.week(league));
  return team.name;
}

// Gold Plan Draft Race: eliminated teams ranked by wins after elimination.
function draftRace(league) {
  const season = settings.season();
  const elim = db.all('SELECT * FROM eliminations WHERE season = ? AND league = ?', season, league);
  const rows = elim.map((e) => {
    const gs = db.all(`SELECT * FROM games WHERE season = ? AND league = ? AND week > ? AND (away_team = ? OR home_team = ?)
      AND status IN ('complete','forfeit','forcewin')`, season, league, e.week, e.team, e.team);
    const wins = gs.filter((g) => g.winner === (g.away_team === e.team ? 'away' : 'home')).length;
    const owner = members.byTeam(league, e.team);
    return { team: e.team, since: e.week, wins, played: gs.length, userId: owner && owner.user_id };
  });
  return rows.sort((a, b) => b.wins - a.wins || a.played - b.played);
}

function setChampions(league, champId, runnerId) {
  const s = settings.season();
  settings.set(`champ:${league}:${s}`, champId);
  settings.set(`runnerup:${league}:${s}`, runnerId);
}

// Promotion / relegation proposal at the end of a season.
function seasonReview(scoreFn) {
  const s = settings.season();
  const min = settings.limit('creatorScoreMin');
  const hl = members.inLeague('HL').map((m) => ({ ...m, score: scoreFn(m.user_id).ovr, stats: games.memberStats(m.user_id) }));
  const nl = members.inLeague('NL').map((m) => ({ ...m, score: scoreFn(m.user_id).ovr, stats: games.memberStats(m.user_id) }));
  const champ = settings.get(`champ:HL:${s}`);
  const runner = settings.get(`runnerup:HL:${s}`);

  const up = [];
  for (const id of [champ, runner]) {
    const m = hl.find((x) => x.user_id === id);
    if (m) up.push({ userId: id, why: id === champ ? 'Huddle League champion' : 'Huddle League runner-up' });
  }
  hl.filter((m) => !up.some((u) => u.userId === m.user_id)).sort((a, b) => b.score - a.score).slice(0, 2)
    .forEach((m) => up.push({ userId: m.user_id, why: `Top streamer (Creator Score ${m.score})` }));

  const down = [];
  const winPct = (st) => { const g = st.record.w + st.record.l + st.record.t; return g ? (st.record.w + st.record.t / 2) / g : 0; };
  nl.slice().sort((a, b) => winPct(a.stats) - winPct(b.stats)).slice(0, 2)
    .forEach((m) => down.push({ userId: m.user_id, why: `Bottom-2 record (${m.stats.record.w}-${m.stats.record.l})` }));
  nl.filter((m) => m.score < min && !down.some((d) => d.userId === m.user_id)).sort((a, b) => a.score - b.score).slice(0, 2)
    .forEach((m) => down.push({ userId: m.user_id, why: `Creator Score ${m.score}, under the ${min} minimum` }));

  return { season: s, up, down, networkLeagueSize: nl.length, champ, runner };
}

module.exports = { ensureClock, leaguesInUse, advance, delayAdvance, setNextAdvance, startSeason, eliminate, draftRace, setChampions, seasonReview };

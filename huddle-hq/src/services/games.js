'use strict';
// Game lifecycle: schedule -> lock -> check in -> kickoff -> final -> credits.
// Implements On The Clock, Final Whistle and the Audible rules.
const db = require('../db');
const settings = require('../settings');
const { bus, UserError } = require('../bus');
const credits = require('./credits');
const strikes = require('./strikes');
const members = require('./members');
const { CREDITS } = require('../constants');
const { parseMatchupLine, DIVISIONS, divisionOf } = require('../lib/teams');
const { MIN, HOUR, ts } = require('../lib/time');

const OPEN = ['scheduled', 'locked', 'kicked', 'final_pending'];
const FINISHED = ['complete', 'forfeit', 'forcewin', 'sim', 'double_loss'];
const other = (side) => (side === 'away' ? 'home' : 'away');
const SIDES = ['away', 'home'];

const getGame = (id) => db.one('SELECT * FROM games WHERE id = ?', id);
const getPlayer = (gameId, side) => db.one('SELECT * FROM game_players WHERE game_id = ? AND side = ?', gameId, side);

function players(gameId) {
  const rows = db.all('SELECT * FROM game_players WHERE game_id = ?', gameId);
  return { away: rows.find((r) => r.side === 'away') || null, home: rows.find((r) => r.side === 'home') || null };
}

function load(id) {
  const game = getGame(id);
  if (!game) throw new UserError(`Game #${id} wasn't found.`);
  return { game, ...players(id) };
}

function sideOf(ctx, userId) {
  if (ctx.away && ctx.away.user_id === userId) return 'away';
  if (ctx.home && ctx.home.user_id === userId) return 'home';
  return null;
}

function flags(game) {
  try { return JSON.parse((game && game.flags) || '{}'); } catch { return {}; }
}
function setFlags(gameId, patch) {
  const f = { ...flags(getGame(gameId)), ...patch };
  db.run('UPDATE games SET flags = ? WHERE id = ?', JSON.stringify(f), gameId);
  return f;
}
const resetReminders = (gameId) => setFlags(gameId, { r15: false, r10: false, r30: false, rStart: false });

const label = (g) => `${g.away_team} @ ${g.home_team}`;
const fullLabel = (g) => `${g.league} WK ${g.week}  |  ${label(g)}`;

const nextAdvance = () => settings.getInt('next_advance_at', 0) || null;
const lockDeadline = (g) => (g.advance_at ? g.advance_at + settings.limit('lockInHours') * HOUR : null);
function latestKickoff() {
  const n = nextAdvance();
  return n ? n - settings.limit('bufferHours') * HOUR : null;
}

// ---------- schedule ----------

function refreshOwners(gameId) {
  const g = getGame(gameId);
  if (!g || !['scheduled', 'locked', 'cpu'].includes(g.status)) return g;
  for (const [side, team] of [['away', g.away_team], ['home', g.home_team]]) {
    const m = members.byTeam(g.league, team);
    const row = getPlayer(gameId, side);
    if (m && !row) {
      db.run('INSERT INTO game_players (game_id, side, user_id) VALUES (?,?,?)', gameId, side, m.user_id);
    } else if (m && row && row.user_id !== m.user_id) {
      db.run('DELETE FROM game_players WHERE game_id = ? AND side = ?', gameId, side);
      db.run('INSERT INTO game_players (game_id, side, user_id) VALUES (?,?,?)', gameId, side, m.user_id);
    } else if (!m && row) {
      db.run('DELETE FROM game_players WHERE game_id = ? AND side = ?', gameId, side);
    }
  }
  const p = players(gameId);
  const human = !!(p.away && p.home);
  if (!human && g.status !== 'cpu') db.run("UPDATE games SET status = 'cpu' WHERE id = ?", gameId);
  if (human && g.status === 'cpu') db.run("UPDATE games SET status = ? WHERE id = ?", g.locked_at ? 'locked' : 'scheduled', gameId);
  return getGame(gameId);
}

function refreshWeekOwners(league, week, season = settings.season()) {
  for (const g of db.all('SELECT id FROM games WHERE season = ? AND league = ? AND week = ?', season, league, week)) refreshOwners(g.id);
}

function importSchedule(league, week, text) {
  const season = settings.season();
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const added = [];
  const errors = [];
  const busy = new Set();
  for (const g of db.all('SELECT away_team, home_team FROM games WHERE season = ? AND league = ? AND week = ?', season, league, week)) {
    busy.add(g.away_team); busy.add(g.home_team);
  }
  const advAt = settings.week(league) === week ? settings.getInt(`advanced_at:${league}`, 0) || null : null;
  db.tx(() => {
    for (const line of lines) {
      const r = parseMatchupLine(line);
      if (!r) continue;
      if (r.error) { errors.push(r.error); continue; }
      if (busy.has(r.away) || busy.has(r.home)) { errors.push(`${r.away} or ${r.home} already has a week ${week} game.`); continue; }
      busy.add(r.away); busy.add(r.home);
      const res = db.run(`INSERT INTO games (season, league, week, away_team, home_team, status, advance_at, created_at)
        VALUES (?,?,?,?,?,'scheduled',?,?)`, season, league, week, r.away, r.home, advAt, Date.now());
      added.push(refreshOwners(res.lastInsertRowid));
    }
  });
  return { added, errors };
}

function clearWeek(league, week) {
  const season = settings.season();
  const rows = db.all("SELECT * FROM games WHERE season = ? AND league = ? AND week = ? AND status IN ('scheduled','cpu','locked') AND kickoff_at IS NULL",
    season, league, week);
  db.tx(() => {
    for (const g of rows) {
      db.run('DELETE FROM game_players WHERE game_id = ?', g.id);
      db.run('DELETE FROM games WHERE id = ?', g.id);
    }
  });
  return rows;
}

const weekGames = (league, week, season = settings.season()) =>
  db.all('SELECT * FROM games WHERE season = ? AND league = ? AND week = ? ORDER BY id', season, league, week);

function gamesForUser(userId, { season = settings.season(), statuses = OPEN } = {}) {
  const marks = statuses.map(() => '?').join(',');
  return db.all(`SELECT g.* FROM games g JOIN game_players p ON p.game_id = g.id
    WHERE p.user_id = ? AND g.season = ? AND g.status IN (${marks}) ORDER BY g.week, g.id`, userId, season, ...statuses);
}

// The game a command refers to: the game thread it was used in, else the member's open game.
function currentGame(userId, channelId) {
  if (channelId) {
    const g = db.one('SELECT * FROM games WHERE thread_id = ?', channelId);
    if (g) return g;
  }
  const open = gamesForUser(userId);
  return open.length ? open[0] : null;
}

// ---------- locking times ----------

function propose(gameId, userId, ms, { staff = false } = {}) {
  const ctx = load(gameId);
  const { game } = ctx;
  const side = sideOf(ctx, userId);
  if (!side && !staff) throw new UserError('Only the two owners in this game can set its time.');
  if (!ctx.away || !ctx.home) throw new UserError('This is a CPU game, so it doesn\'t need a game time.');
  if (!['scheduled', 'locked'].includes(game.status)) throw new UserError('This game is already underway or finished.');
  const now = Date.now();
  if (ms < now + 5 * MIN) throw new UserError('Pick a kickoff at least 5 minutes from now.');
  const latest = latestKickoff();
  if (latest && ms > latest && !staff) {
    throw new UserError(`Kickoff has to be by ${ts(latest)}, ${settings.limit('bufferHours')} hours before the next advance.`);
  }
  if (game.status === 'locked' && ms === game.locked_at) throw new UserError('That is already the locked kickoff time.');
  db.run('UPDATE games SET proposed_at = ?, proposed_by = ?, proposed_on = ? WHERE id = ?', ms, userId, now, gameId);
  return { ...load(gameId), side, audible: game.status === 'locked' };
}

function withdrawProposal(gameId) {
  db.run('UPDATE games SET proposed_at = NULL, proposed_by = NULL, proposed_on = NULL WHERE id = ?', gameId);
  return load(gameId);
}

function confirm(gameId, userId, ms, { staff = false } = {}) {
  const ctx = load(gameId);
  const { game } = ctx;
  if (!game.proposed_at) throw new UserError('There is no game time waiting for confirmation.');
  if (game.proposed_at !== ms) throw new UserError('That proposal was replaced by a newer one. Use the newest one in the thread.');
  if (!['scheduled', 'locked'].includes(game.status)) throw new UserError('This game is already underway or finished.');
  const side = sideOf(ctx, userId);
  if (!staff) {
    if (!side) throw new UserError('Only the opponent can confirm this time.');
    if (game.proposed_by === userId) throw new UserError('Your opponent has to confirm the time you proposed.');
  }
  const now = Date.now();
  const audible = game.status === 'locked';
  const result = { audible, late: false, lockIn: false, outOfAudibles: false, audiblesLeft: null, proposer: game.proposed_by };

  db.tx(() => {
    if (audible) {
      const proposer = game.proposed_by;
      const pside = sideOf(ctx, proposer);
      const season = settings.season();
      const used = db.one('SELECT COUNT(*) AS n FROM audibles WHERE user_id = ? AND season = ? AND late = 0', proposer, season).n;
      const allowed = settings.limit('audiblesPerSeason');
      let late = game.locked_at - now < settings.limit('audibleNoticeHours') * HOUR;
      if (used >= allowed) { late = true; result.outOfAudibles = true; }
      db.run('INSERT INTO audibles (user_id, season, game_id, late, created_at) VALUES (?,?,?,?,?)', proposer, season, gameId, late ? 1 : 0, now);
      if (late && pside) {
        db.run('UPDATE game_players SET no_credit = 1 WHERE game_id = ? AND side = ?', gameId, pside);
        db.run('UPDATE members SET ontime_streak = 0 WHERE user_id = ?', proposer);
      }
      result.late = late;
      result.audiblesLeft = Math.max(0, allowed - used - (late ? 0 : 1));
      db.run('UPDATE games SET locked_at = ?, locked_on = ?, proposed_at = NULL, proposed_by = NULL, proposed_on = NULL WHERE id = ?', ms, now, gameId);
      resetReminders(gameId);
    } else {
      db.run(`UPDATE games SET status = 'locked', locked_at = ?, locked_on = ?, proposed_at = NULL, proposed_by = NULL, proposed_on = NULL
        WHERE id = ?`, ms, now, gameId);
      const deadline = lockDeadline(game);
      if (deadline && now <= deadline) {
        for (const p of [ctx.away, ctx.home]) credits.earn(p.user_id, 'lockIn', { ref: `lockin:${gameId}`, unique: true, reason: `Lock In (${label(game)})` });
        result.lockIn = true;
      }
    }
  });
  return { ...load(gameId), ...result };
}

// Staff sets a default time (no Lock In credit).
function assignTime(gameId, ms) {
  const ctx = load(gameId);
  if (!['scheduled', 'locked'].includes(ctx.game.status)) throw new UserError('This game is already underway or finished.');
  if (!ctx.away || !ctx.home) throw new UserError('This is a CPU game.');
  db.run(`UPDATE games SET status = 'locked', locked_at = ?, locked_on = ?, proposed_at = NULL, proposed_by = NULL, proposed_on = NULL
    WHERE id = ?`, ms, Date.now(), gameId);
  resetReminders(gameId);
  return load(gameId);
}

// ---------- going live ----------

function openSession(userId, nowMs = Date.now()) {
  return db.one('SELECT * FROM live_sessions WHERE user_id = ? AND ended_at IS NULL AND started_at >= ? ORDER BY started_at DESC LIMIT 1',
    userId, nowMs - 10 * HOUR);
}

// If the bot already saw this player go live, use that as their check-in.
function pickUpSession(ctx, side, now) {
  const p = ctx[side];
  if (!p || p.checkin_at) return p;
  const sess = openSession(p.user_id, now);
  if (!sess) return p;
  const g = ctx.game;
  const start = g.locked_at ? Math.max(sess.started_at, g.locked_at - 2 * HOUR) : sess.started_at;
  db.run('UPDATE game_players SET checkin_at = ?, stream_url = COALESCE(stream_url, ?), verified = 1 WHERE game_id = ? AND side = ?',
    start, sess.url, g.id, side);
  return getPlayer(g.id, side);
}

// Applies to a game in progress, or a locked game from 2 hrs before to 3 hrs after kickoff.
function checkIn(userId, { url = null, at = Date.now(), gameId = null } = {}) {
  const candidates = gameId ? [getGame(gameId)].filter(Boolean) : gamesForUser(userId, { statuses: ['locked', 'kicked', 'final_pending'] });
  const hits = [];
  for (const g of candidates) {
    const ctx = load(g.id);
    const side = sideOf(ctx, userId);
    if (!side) continue;
    const inPlay = g.status === 'kicked' || g.status === 'final_pending';
    const inWindow = g.status === 'locked' && g.locked_at && at >= g.locked_at - 2 * HOUR && at <= g.locked_at + 3 * HOUR;
    if (!inPlay && !inWindow) continue;
    const p = ctx[side];
    const first = !p.checkin_at;
    db.run(`UPDATE game_players SET checkin_at = COALESCE(checkin_at, ?), stream_url = COALESCE(?, stream_url), verified = 1
      WHERE game_id = ? AND side = ?`, at, url, g.id, side);
    const paid = settle(g.id, side);
    hits.push({ game: getGame(g.id), side, first, paid });
  }
  return hits;
}

function timingFor(lateMin) {
  if (lateMin <= 5) return 'ontime';
  if (lateMin <= 15) return 'late';
  if (lateMin <= 30) return 'very_late';
  return 'no_show';
}

function kickoff(gameId, userId, { staff = false } = {}) {
  const ctx = load(gameId);
  const { game } = ctx;
  const side = sideOf(ctx, userId);
  if (!side && !staff) throw new UserError('Only the two owners in this game can kick it off.');
  if (!ctx.away || !ctx.home) throw new UserError('CPU games don\'t need a kickoff.');
  if (game.status === 'kicked' || game.status === 'final_pending') throw new UserError(`This game kicked off ${ts(game.kickoff_at, 'R')}.`);
  if (!['scheduled', 'locked'].includes(game.status)) throw new UserError('This game is already finished.');
  const now = Date.now();
  const locked = game.status === 'locked' && !!game.locked_at;
  const timings = {};

  db.tx(() => {
    for (const s of SIDES) {
      const p = pickUpSession(ctx, s, now);
      if (!locked) continue;
      const valid = p.checkin_at && p.checkin_at >= game.locked_at - 2 * HOUR ? p.checkin_at : null;
      const arrival = Math.min(valid || now, now);
      const late = Math.max(0, Math.ceil((arrival - game.locked_at) / MIN));
      const timing = timingFor(late);
      db.run('UPDATE game_players SET arrival_at = ?, minutes_late = ?, timing = ? WHERE game_id = ? AND side = ?', arrival, late, timing, gameId, s);
      timings[s] = { timing, late, userId: p.user_id };
    }
    db.run("UPDATE games SET status = 'kicked', kickoff_at = ?, kickoff_by = ? WHERE id = ?", now, userId, gameId);
  });

  for (const t of Object.values(timings)) {
    if (t.timing !== 'ontime') db.run('UPDATE members SET ontime_streak = 0 WHERE user_id = ?', t.userId);
    if (t.timing === 'very_late') t.strike = strikes.add(t.userId, 'late', `Kicked off ${t.late} min late: ${label(game)}`, { gameId });
    if (t.timing === 'no_show') t.strike = strikes.add(t.userId, 'late30', `Kicked off ${t.late} min late: ${label(game)}`, { gameId });
  }
  const paid = { away: settle(gameId, 'away'), home: settle(gameId, 'home') };
  return { ...load(gameId), timings, paid, locked };
}

// ---------- finals ----------

function validScore(n) {
  return Number.isInteger(n) && n >= 0 && n <= 199;
}

function submitFinal(gameId, userId, awayScore, homeScore, { staff = false } = {}) {
  const ctx = load(gameId);
  const { game } = ctx;
  const side = sideOf(ctx, userId);
  if (!side && !staff) throw new UserError('Only the two owners in this game can report the score.');
  if (!ctx.away || !ctx.home) throw new UserError('This is a CPU game.');
  if (!validScore(awayScore) || !validScore(homeScore)) throw new UserError('Scores must be whole numbers from 0 to 199.');
  if (!OPEN.includes(game.status)) throw new UserError('This game already has a final result.');
  if (game.status === 'final_pending' && game.final_by !== userId && !staff) {
    throw new UserError('A score is already waiting for your confirmation. Confirm it or dispute it in the game thread.');
  }
  const now = Date.now();
  db.tx(() => {
    if (game.status === 'scheduled' || game.status === 'locked') {
      // No Kickoff press: punctuality can still be credited from live check-ins, never penalised.
      for (const s of SIDES) {
        const p = pickUpSession(ctx, s, now);
        if (game.status === 'locked' && p.checkin_at && p.checkin_at >= game.locked_at - 2 * HOUR) {
          const late = Math.max(0, Math.ceil((p.checkin_at - game.locked_at) / MIN));
          if (late <= 5) db.run("UPDATE game_players SET arrival_at = ?, minutes_late = ?, timing = 'ontime' WHERE game_id = ? AND side = ?", p.checkin_at, late, gameId, s);
        }
      }
    }
    db.run("UPDATE games SET status = 'final_pending', away_score = ?, home_score = ?, final_by = ?, final_at = ? WHERE id = ?",
      awayScore, homeScore, userId, now, gameId);
  });
  setFlags(gameId, { disputed: false });
  if (staff && !side) return confirmFinal(gameId, userId, { staff: true });
  return { ...load(gameId), pending: true };
}

function teamRecord(league, team, season = settings.season(), excludeId = null) {
  const rows = db.all(`SELECT * FROM games WHERE season = ? AND league = ? AND (away_team = ? OR home_team = ?)
    AND status IN ('complete','forfeit','forcewin','double_loss') AND id <> ?`, season, league, team, team, excludeId || -1);
  let w = 0; let l = 0; let t = 0;
  for (const g of rows) {
    const side = g.away_team === team ? 'away' : 'home';
    if (g.status === 'double_loss') l++;
    else if (g.winner === 'tie') t++;
    else if (g.winner === side) w++;
    else if (g.winner) l++;
  }
  const games = w + l + t;
  return { w, l, t, games, pct: games ? (w + t / 2) / games : 0 };
}

const recordText = (r) => `${r.w}-${r.l}${r.t ? `-${r.t}` : ''}`;

function isEliminated(league, team, season = settings.season()) {
  return !!db.one('SELECT 1 AS x FROM eliminations WHERE season = ? AND league = ? AND team = ?', season, league, team);
}

// Nothing To Lose: an underdog (or eliminated team) beating a contender.
function checkSpoiler(game, winner) {
  if (winner === 'tie') return null;
  const wTeam = game[`${winner}_team`];
  const lTeam = game[`${other(winner)}_team`];
  const wr = teamRecord(game.league, wTeam, game.season, game.id);
  const lr = teamRecord(game.league, lTeam, game.season, game.id);
  const underdog = wr.games >= 3 && lr.games >= 3 && wr.pct <= 0.4 && lr.pct >= 0.6;
  const spoilerElim = isEliminated(game.league, wTeam, game.season) && !isEliminated(game.league, lTeam, game.season) && lr.games >= 3 && lr.pct >= 0.5;
  if (!underdog && !spoilerElim) return null;
  return { winnerTeam: wTeam, loserTeam: lTeam, winnerRecord: recordText(wr), loserRecord: recordText(lr) };
}

function confirmFinal(gameId, userId, { staff = false, auto = false } = {}) {
  const ctx = load(gameId);
  const { game } = ctx;
  if (game.status !== 'final_pending') throw new UserError('There is no score waiting for confirmation.');
  if (!auto && !staff) {
    const side = sideOf(ctx, userId);
    if (!side) throw new UserError('Only the opponent can confirm this score.');
    if (userId === game.final_by) throw new UserError('Your opponent confirms the score you reported.');
  }
  const winner = game.away_score > game.home_score ? 'away' : game.home_score > game.away_score ? 'home' : 'tie';
  const spoiler = checkSpoiler(game, winner);
  db.tx(() => {
    db.run("UPDATE games SET status = 'complete', completed_at = ?, winner = ? WHERE id = ?", Date.now(), winner, gameId);
    db.run("UPDATE game_players SET outcome = 'complete' WHERE game_id = ?", gameId);
  });
  const paid = { away: settle(gameId, 'away'), home: settle(gameId, 'home') };
  if (spoiler) {
    const w = ctx[winner];
    spoiler.userId = w.user_id;
    spoiler.paid = credits.earn(w.user_id, 'spoilerBounty', { ref: `spoiler:${gameId}`, unique: true, reason: `Spoiler Bounty (${label(game)})` });
    bus.emit('spoiler', { gameId, ...spoiler });
  }
  const after = load(gameId);
  const unverified = SIDES.filter((s) => after[s] && !after[s].verified);
  return { ...after, winner, paid, spoiler, unverified, auto };
}

function dispute(gameId, userId) {
  const ctx = load(gameId);
  if (ctx.game.status !== 'final_pending') throw new UserError('There is no score to dispute.');
  const side = sideOf(ctx, userId);
  if (!side) throw new UserError('Only the two owners can dispute a score.');
  if (ctx.game.final_by === userId) throw new UserError('You reported this score. Submit a corrected one with Final Score instead.');
  setFlags(gameId, { disputed: true });
  bus.emit('dispute', { gameId, userId });
  return load(gameId);
}

function addVod(gameId, userId, url, { staff = false } = {}) {
  const ctx = load(gameId);
  const side = sideOf(ctx, userId);
  if (!side && !staff) throw new UserError('Only the two owners can add a VOD for this game.');
  const target = side || 'away';
  db.run('UPDATE game_players SET vod_url = ? WHERE game_id = ? AND side = ?', url, gameId, target);
  return { ...load(gameId), paid: settle(gameId, target) };
}

// ---------- credits ----------

// Pays whatever this player is owed for this game. Safe to call any number of times.
function settle(gameId, side) {
  const g = getGame(gameId);
  const p = getPlayer(gameId, side);
  if (!g || !p) return [];
  const m = members.get(p.user_id);
  if (!m) return [];
  const paid = [];
  const locked = !!g.locked_at;
  const pay = (key, ref) => {
    const r = credits.earn(p.user_id, key, { ref, unique: true, reason: `${CREDITS[key][1].split(':')[0]} (${label(g)})` });
    if (r.ok) paid.push({ key, amount: r.amount });
  };

  if (p.verified && locked && p.timing === 'ontime' && !p.no_credit && !p.ontime_paid) {
    db.run('UPDATE game_players SET ontime_paid = 1 WHERE game_id = ? AND side = ?', gameId, side);
    pay('onTime', `ontime:${gameId}`);
    const streak = (m.ontime_streak || 0) + 1;
    db.run('UPDATE members SET ontime_streak = ?, best_ontime_streak = MAX(COALESCE(best_ontime_streak,0), ?) WHERE user_id = ?', streak, streak, p.user_id);
    if (streak === 3) pay('streak3', `streak3:${gameId}`);
    if (streak === 5) pay('streak5', `streak5:${gameId}`);
    if (streak === 10) { pay('streak10', `streak10:${gameId}`); bus.emit('ironClock', { userId: p.user_id }); }
  }
  if (p.verified && p.outcome === 'complete' && !p.complete_paid) {
    db.run('UPDATE game_players SET complete_paid = 1 WHERE game_id = ? AND side = ?', gameId, side);
    pay('complete', `complete:${gameId}`);
    const cs = (members.get(p.user_id).complete_streak || 0) + 1;
    db.run('UPDATE members SET complete_streak = ? WHERE user_id = ?', cs, p.user_id);
    if (cs % 8 === 0) pay('completeStreak8', `cstreak:${gameId}`);
  }
  if (p.verified && locked && p.outcome === 'complete' && p.timing === 'ontime' && !p.no_credit && !p.double_paid) {
    db.run('UPDATE game_players SET double_paid = 1 WHERE game_id = ? AND side = ?', gameId, side);
    pay('double', `double:${gameId}`);
  }
  if (p.vod_url && p.outcome === 'complete' && !p.vod_paid) {
    db.run('UPDATE game_players SET vod_paid = 1 WHERE game_id = ? AND side = ?', gameId, side);
    pay('fullBroadcast', `vod:${gameId}`);
  }
  return paid;
}

// ---------- rulings ----------

function applyRuling(gameId, { status, winner = null, outcomes = {}, strikeSides = [], strikeKind = 'unplayed', reason, by }) {
  const ctx = load(gameId);
  if (FINISHED.includes(ctx.game.status)) throw new UserError('This game already has a result. Use /ruling reopen first if it needs to change.');
  if (!ctx.away || !ctx.home) throw new UserError('This is a CPU game.');
  db.tx(() => {
    db.run('UPDATE games SET status = ?, winner = ?, completed_at = ? WHERE id = ?', status, winner, Date.now(), gameId);
    for (const [s, o] of Object.entries(outcomes)) {
      db.run('UPDATE game_players SET outcome = ? WHERE game_id = ? AND side = ?', o, gameId, s);
      if (o === 'fault') db.run('UPDATE members SET complete_streak = 0 WHERE user_id = ?', ctx[s].user_id);
    }
  });
  const struck = strikeSides.map((s) => ({ side: s, ...strikes.add(ctx[s].user_id, strikeKind, `${reason}: ${label(ctx.game)}`, { gameId, by }) }));
  const paid = { away: settle(gameId, 'away'), home: settle(gameId, 'home') };
  bus.emit('ruling', { gameId, status, winner, by, reason });
  return { ...load(gameId), struck, paid };
}

function forceWin(gameId, winnerSide, { strike = true, kind = 'unplayed', by } = {}) {
  const loser = other(winnerSide);
  return applyRuling(gameId, {
    status: 'forcewin', winner: winnerSide, outcomes: { [winnerSide]: 'excused', [loser]: 'fault' },
    strikeSides: strike ? [loser] : [], strikeKind: kind, reason: kind === 'noshow' ? 'No-show' : 'Unplayed game', by,
  });
}

function rageQuit(gameId, quitterSide, { by } = {}) {
  const victim = other(quitterSide);
  db.run('UPDATE game_players SET verified = 1 WHERE game_id = ? AND side = ?', gameId, victim);
  return applyRuling(gameId, {
    status: 'forfeit', winner: victim, outcomes: { [quitterSide]: 'fault', [victim]: 'complete' },
    strikeSides: [quitterSide], strikeKind: 'ragequit', reason: 'Rage quit', by,
  });
}

function sim(gameId, { strikeBoth = false, by } = {}) {
  const o = strikeBoth ? 'fault' : 'excused';
  return applyRuling(gameId, {
    status: 'sim', outcomes: { away: o, home: o }, strikeSides: strikeBoth ? SIDES : [], strikeKind: 'unplayed', reason: 'Unplayed game (sim)', by,
  });
}

function doubleLoss(gameId, { by } = {}) {
  return applyRuling(gameId, {
    status: 'double_loss', outcomes: { away: 'fault', home: 'fault' }, strikeSides: SIDES, strikeKind: 'unplayed', reason: 'Unplayed game (double loss)', by,
  });
}

function verifyLive(gameId, side) {
  const g = getGame(gameId);
  db.run('UPDATE game_players SET verified = 1, checkin_at = COALESCE(checkin_at, ?) WHERE game_id = ? AND side = ?', g.kickoff_at || Date.now(), gameId, side);
  return { ...load(gameId), paid: settle(gameId, side) };
}

function reopen(gameId) {
  const g = getGame(gameId);
  if (!g) throw new UserError('Game not found.');
  db.tx(() => {
    db.run(`UPDATE games SET status = ?, kickoff_at = NULL, kickoff_by = NULL, away_score = NULL, home_score = NULL, final_by = NULL,
      final_at = NULL, completed_at = NULL, winner = NULL WHERE id = ?`, g.locked_at ? 'locked' : 'scheduled', gameId);
    db.run('UPDATE game_players SET outcome = NULL, timing = NULL, arrival_at = NULL, minutes_late = NULL WHERE game_id = ?', gameId);
  });
  resetReminders(gameId);
  return load(gameId);
}

// ---------- advance close-out ----------

function suggestRuling(ctx) {
  const a = !!(ctx.away && (ctx.away.checkin_at || ctx.away.verified));
  const h = !!(ctx.home && (ctx.home.checkin_at || ctx.home.verified));
  if (a && !h) return { type: 'forcewin', side: 'away' };
  if (h && !a) return { type: 'forcewin', side: 'home' };
  return { type: 'sim' };
}

// Runs right before a league advances: confirm finals, flag unplayed games, pay division bonuses.
function closeWeek(league, week) {
  const season = settings.season();
  for (const g of db.all("SELECT * FROM games WHERE season = ? AND league = ? AND week = ? AND status = 'final_pending'", season, league, week)) {
    if (!flags(g).disputed) confirmFinal(g.id, null, { auto: true });
  }
  const unplayed = [];
  for (const g of db.all("SELECT * FROM games WHERE season = ? AND league = ? AND week = ? AND status IN ('scheduled','locked','kicked','final_pending')",
    season, league, week)) {
    const ctx = load(g.id);
    if (!ctx.away || !ctx.home) { db.run("UPDATE games SET status = 'cpu' WHERE id = ?", g.id); continue; }
    db.run("UPDATE games SET status = 'unplayed' WHERE id = ?", g.id);
    unplayed.push({ ...load(g.id), suggestion: suggestRuling(ctx) });
  }

  const games = weekGames(league, week, season).filter((g) => g.status !== 'cpu');
  const bonuses = [];
  for (const div of DIVISIONS) {
    const dg = games.filter((g) => divisionOf(g.away_team) === div || divisionOf(g.home_team) === div)
      .map((g) => ({ g, ...players(g.id) })).filter((x) => x.away && x.home);
    if (!dg.length) continue;
    const divMembers = new Set();
    for (const x of dg) for (const s of SIDES) if (divisionOf(x.g[`${s}_team`]) === div) divMembers.add(x[s].user_id);
    const allOnTime = dg.every((x) => x.away.timing === 'ontime' && x.home.timing === 'ontime');
    const allComplete = dg.every((x) => x.g.status === 'complete');
    for (const uid of divMembers) {
      if (allOnTime) credits.earn(uid, 'cleanDivision', { ref: `cleandiv:${season}:${league}:${week}:${div}`, unique: true, reason: `Clean Division (${div}, WK ${week})` });
      if (allComplete) credits.earn(uid, 'cleanAdvance', { ref: `cleanadv:${season}:${league}:${week}:${div}`, unique: true, reason: `Clean Advance (${div}, WK ${week})` });
    }
    if (allOnTime || allComplete) bonuses.push({ div, allOnTime, allComplete, count: divMembers.size });
  }
  return { unplayed, bonuses };
}

// ---------- stats ----------

function memberStats(userId, season = settings.season()) {
  const rows = db.all(`SELECT p.*, g.status, g.winner, g.locked_at FROM game_players p JOIN games g ON g.id = p.game_id
    WHERE p.user_id = ? AND g.season = ?`, userId, season);
  const timed = rows.filter((r) => r.timing);
  const ontime = timed.filter((r) => r.timing === 'ontime').length;
  const counted = rows.filter((r) => r.outcome === 'complete' || r.outcome === 'fault');
  const complete = counted.filter((r) => r.outcome === 'complete').length;
  let w = 0; let l = 0; let t = 0;
  for (const r of rows) {
    if (r.status === 'double_loss') l++;
    else if (['complete', 'forfeit', 'forcewin'].includes(r.status) && r.winner) {
      if (r.winner === 'tie') t++;
      else if (r.winner === r.side) w++;
      else l++;
    }
  }
  return {
    games: rows.length, timed: timed.length, ontime, counted: counted.length, complete,
    onTimeRate: timed.length ? ontime / timed.length : null,
    completeRate: counted.length ? complete / counted.length : null,
    record: { w, l, t },
  };
}

function primeTimeEligible(userId) {
  const s = memberStats(userId);
  const okOnTime = s.onTimeRate === null || s.onTimeRate * 100 >= settings.limit('primeTimeOnTime');
  const okComplete = s.completeRate === null || s.completeRate * 100 >= settings.limit('primeTimeComplete');
  const okStrikes = strikes.count(userId) < settings.limit('strikesFreeze');
  return { ok: okOnTime && okComplete && okStrikes, okOnTime, okComplete, okStrikes, stats: s };
}

module.exports = {
  OPEN, FINISHED, SIDES, other, getGame, getPlayer, players, load, sideOf, flags, setFlags, label, fullLabel,
  nextAdvance, lockDeadline, latestKickoff, refreshOwners, refreshWeekOwners, importSchedule, clearWeek, weekGames,
  gamesForUser, currentGame, propose, withdrawProposal, confirm, assignTime, openSession, checkIn, kickoff, submitFinal,
  confirmFinal, dispute, addVod, settle, forceWin, rageQuit, sim, doubleLoss, verifyLive, reopen, closeWeek,
  teamRecord, recordText, isEliminated, memberStats, primeTimeEligible, timingFor,
};

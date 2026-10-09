'use strict';
// Everything that runs on the clock: advance countdowns and rollover, lock and check-in reminders,
// no-show alerts, auto-confirms, trade auto-pass, Clip of the Week close, daily posts, weekly bonuses.
const db = require('./db');
const settings = require('./settings');
const api = require('./discord/api');
const ui = require('./lib/ui');
const games = require('./services/games');
const members = require('./services/members');
const credits = require('./services/credits');
const league = require('./services/league');
const trades = require('./services/trades');
const clips = require('./services/clips');
const gameView = require('./views/game');
const scheduleView = require('./views/schedule');
const tradesModule = require('./modules/trades');
const clipsModule = require('./modules/clips');
const gamesModule = require('./modules/games');
const network = require('./modules/network');
const { ts, at, parts, weekStart, dayKey, MIN, HOUR, DAY, PT } = require('./lib/time');
const { BRAND, LEAGUES } = require('./constants');

function once(key, fn) {
  if (db.one('SELECT key FROM job_runs WHERE key = ?', key)) return false;
  db.run('INSERT INTO job_runs (key, ran_at) VALUES (?, ?)', key, Date.now());
  return fn() || true;
}
const ranAlready = (key) => !!db.one('SELECT key FROM job_runs WHERE key = ?', key);
const markRan = (key) => db.run('INSERT OR IGNORE INTO job_runs (key, ran_at) VALUES (?, ?)', key, Date.now());

function unfinished(now = Date.now()) {
  const out = [];
  for (const l of settings.activeLeagues()) {
    for (const g of games.weekGames(l, settings.week(l))) {
      if (!games.OPEN.includes(g.status)) continue;
      const p = games.players(g.id);
      if (p.away && p.home) out.push({ g, p });
    }
  }
  return out;
}

// ---------- advance clock ----------

async function advanceClock(now) {
  const next = league.ensureClock(now);
  const grace = settings.limit('advanceGraceMinutes') * MIN;

  if (now >= next + grace) {
    const rolled = league.delayAdvance();
    await api.post('advance', { embeds: [ui.embed({ title: '⏩ ADVANCE MOVED TO TOMORROW', description: `No advance at 8 PM PT, so it moves to **${ts(rolled, 'F')}** (${ts(rolled, 'R')}). Use the extra day to finish your games.`, color: BRAND.gold })] });
    return;
  }

  const noon = at(next, 0, 12, 0, PT);
  if (now >= noon && now < next && !ranAlready(`advnoon:${next}`)) {
    markRan(`advnoon:${next}`);
    const left = unfinished(now);
    const lines = left.slice(0, 25).map(({ g, p }) => `• **${games.label(g)}** ${ui.mention(p.away.user_id)} ${ui.mention(p.home.user_id)} · ${g.status === 'locked' ? `kickoff ${ts(g.locked_at, 't')}` : g.status === 'scheduled' ? 'not locked' : g.status === 'kicked' ? 'in progress' : 'confirm the final'}`);
    await api.post('advance', {
      embeds: [ui.embed({ title: `ADVANCE TONIGHT  |  ${ts(next, 't')}`, description: `${ts(next, 'R')}\n\n${left.length ? `**Still to finish (${left.length}):**\n${lines.join('\n')}` : 'Every game is done. Clean advance incoming.'}`, color: BRAND.red })],
      allowed_mentions: { parse: ['users'] },
    });
  }

  if (now >= next - 60 * MIN && now < next && !ranAlready(`adv60:${next}`)) {
    markRan(`adv60:${next}`);
    const left = unfinished(now);
    if (left.length) {
      const pings = [...new Set(left.flatMap(({ p }) => [p.away.user_id, p.home.user_id]))].map(ui.mention).join(' ');
      await api.post('advance', { content: `⏰ **1 hour to the advance.** Games still open: ${left.map(({ g }) => games.label(g)).join(', ')}\n${pings}`.slice(0, 2000) });
    }
  }
}

// ---------- per-game reminders ----------

async function gameReminders(now) {
  const lockH = settings.limit('lockInHours');
  for (const { g, p } of unfinished(now)) {
    const f = games.flags(g);

    // Lock reminders
    if (g.status === 'scheduled' && g.advance_at) {
      const deadline = g.advance_at + lockH * HOUR;
      if (!f.rLock && now >= deadline - 4 * HOUR && now < deadline) {
        games.setFlags(g.id, { rLock: true });
        await gameView.say(g.id, `${ui.mention(p.away.user_id)} ${ui.mention(p.home.user_id)} ⏳ Lock your game time by ${ts(deadline, 't')} for +${settings.credit('lockIn')} each. Tap **Suggest Times** on the game post.`);
      }
      if (!f.rLockMiss && now >= deadline) {
        games.setFlags(g.id, { rLockMiss: true });
        await gameView.refresh(g.id);
      }
    }

    if (g.status !== 'locked' || !g.locked_at) continue;
    const k = g.locked_at;

    if (!f.r15 && now >= k - 15 * MIN && now < k) {
      games.setFlags(g.id, { r15: true });
      await gameView.say(g.id, `${ui.mention(p.away.user_id)} ${ui.mention(p.home.user_id)} 🔴 **Kickoff in 15.** Go live now. Tap **I'm Live** if the bot hasn't checked you in.`);
    }

    if (!f.r10 && now >= k - 10 * MIN && now < k + 30 * MIN) {
      games.setFlags(g.id, { r10: true });
      const missing = ['away', 'home'].filter((s) => !p[s].checkin_at && !games.openSession(p[s].user_id, now));
      if (missing.length) {
        await gameView.say(g.id, `⚠️ Not checked in yet: ${missing.map((s) => ui.mention(p[s].user_id)).join(' ')}. Kickoff is ${ts(k, 'R')}.`);
      }
    }

    if (!f.r30 && now >= k + 30 * MIN) {
      games.setFlags(g.id, { r30: true });
      const ctx = games.load(g.id);
      const live = ['away', 'home'].filter((s) => ctx[s].checkin_at || games.openSession(ctx[s].user_id, now));
      const noShowSide = live.length === 1 ? games.other(live[0]) : null;
      await gameView.say(g.id, {
        content: noShowSide ? `${ui.mention(ctx[noShowSide].user_id)} it's 30 minutes past kickoff.` : undefined,
        embeds: [ui.embed({ description: `⏰ **30 minutes past kickoff and no Kickoff logged.**${noShowSide ? `\n${ui.mention(ctx[live[0]].user_id)}, you were on time. You can request a force-win.` : '\nIf you\'re playing, tap **Kickoff** now.'}`, color: BRAND.gold })],
        components: noShowSide ? ui.rows([ui.button(`game:fwreq:${g.id}`, 'Request force-win', 'danger')]) : [],
      });
      await api.post('staffAlerts', {
        embeds: [ui.embed({ title: 'NO KICKOFF AT T+30', description: `${games.fullLabel(g)}\nLocked for ${ts(k, 'f')}.\nLive: ${live.length ? live.map((s) => ui.mention(ctx[s].user_id)).join(', ') : 'nobody checked in'}${g.thread_id ? `\nThread: <#${g.thread_id}>` : ''}\nWait for the owners, or rule now:`, color: BRAND.gold })],
        components: gamesModule.rulingButtons(ctx, { noShowSide }),
      });
    }
  }
}

async function autoConfirmFinals(now) {
  const hours = settings.limit('finalAutoConfirmHours');
  const due = db.all("SELECT * FROM games WHERE status = 'final_pending' AND final_at <= ?", now - hours * HOUR);
  for (const g of due) {
    if (games.flags(g).disputed) continue;
    const r = games.confirmFinal(g.id, null, { auto: true });
    await gamesModule.announceComplete(g.id, r);
  }
}

// ---------- daily and weekly ----------

async function daily(now) {
  const p = parts(now, PT);
  const day = dayKey(now);

  if (p.hour >= 9 && !ranAlready(`media:${day}`)) {
    markRan(`media:${day}`);
    const brief = network.mediaBrief(now);
    if (brief) await api.post('mediaDesk', { embeds: [brief] });
  }

  if (p.hour >= 12 && !ranAlready(`tonight:${day}`)) {
    markRan(`tonight:${day}`);
    const e = scheduleView.tonightEmbed(now);
    if (e) await api.post('tonight', { embeds: [e] });
  }

  // Complete Week: pay last week once all of its games are resolved.
  if (p.hour >= 9) {
    const lastWeek = weekStart(now) - 7 * DAY;
    const key = `cweek:${dayKey(lastWeek)}`;
    if (!ranAlready(key)) {
      const end = weekStart(now);
      const rows = db.all(`SELECT p.user_id, g.status, p.outcome FROM games g JOIN game_players p ON p.game_id = g.id
        WHERE g.season = ? AND g.advance_at >= ? AND g.advance_at < ? AND g.status <> 'cpu'`, settings.season(), lastWeek, end);
      const pending = rows.some((r) => games.OPEN.includes(r.status) || r.status === 'unplayed');
      if (!pending || now - end > 3 * DAY) {
        markRan(key);
        const byUser = {};
        for (const r of rows) (byUser[r.user_id] = byUser[r.user_id] || []).push(r);
        for (const [uid, list] of Object.entries(byUser)) {
          if (list.length && list.every((r) => r.outcome === 'complete')) {
            credits.earn(uid, 'completeWeek', { ref: `cweek:${dayKey(lastWeek)}`, unique: true, reason: `Complete Week (week of ${dayKey(lastWeek)})` });
          }
        }
      }
    }
  }

  if (p.weekday === 7 && p.hour >= 19 && !ranAlready(`board:${day}`)) {
    markRan(`board:${day}`);
    const board = network.reliabilityBoard();
    if (board) await api.post('reliability', { embeds: [board] });
  }

  if (p.weekday === 1 && p.hour >= 4 && !ranAlready(`backup:${day}`)) {
    markRan(`backup:${day}`);
    try {
      await api.post('staffAlerts', { content: '🗄️ Weekly backup. Keep a copy somewhere safe.', files: network.backupFiles() });
    } catch (e) { console.warn(`[backup] ${e.message}`); }
  }
}

async function tradesAndClips(now) {
  for (const r of trades.expireDue(now)) await tradesModule.onDecided(r.trade, { auto: true });
  for (const p of clips.openPolls()) {
    if (p.closes_at <= now) {
      try { await clipsModule.closeVote(p.id); } catch (e) { console.warn(`[cotw] ${e.message}`); }
    }
  }
}

// ---------- loop ----------

let running = false;
async function tick() {
  if (running) return;
  running = true;
  const now = Date.now();
  const steps = [advanceClock, gameReminders, autoConfirmFinals, tradesAndClips, daily];
  for (const step of steps) {
    try { await step(now); } catch (e) { console.error(`[scheduler] ${step.name}:`, e); }
  }
  running = false;
}

function start() {
  setTimeout(tick, 5000);
  return setInterval(tick, 30 * 1000);
}

module.exports = { start, tick, advanceClock, gameReminders, autoConfirmFinals, daily, tradesAndClips, once, unfinished, LEAGUES };

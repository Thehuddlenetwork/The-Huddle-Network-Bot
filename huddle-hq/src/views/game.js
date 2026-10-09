'use strict';
// Game post (one per game in #hl-game-times / #nl-game-times) with its own thread and buttons.
const db = require('../db');
const api = require('../discord/api');
const settings = require('../settings');
const games = require('../services/games');
const members = require('../services/members');
const ui = require('../lib/ui');
const { ts } = require('../lib/time');
const { BRAND } = require('../constants');

const TIMING = {
  ontime: '⏱️ on time',
  late: '🕒 late',
  very_late: '🟠 late (strike)',
  no_show: '🔴 30+ min late (strike)',
};

function playerLine(g, p, side) {
  const team = g[`${side}_team`].toUpperCase();
  if (!p) return `**${team}**  CPU`;
  const m = members.get(p.user_id);
  const bits = [`**${team}**  ${ui.mention(p.user_id)}`];
  const url = p.stream_url || (m && m.stream_url);
  if (url) bits.push(`[watch](${url})`);
  if (p.checkin_at) bits.push(`🔴 live ${ts(p.checkin_at, 't')}`);
  if (p.timing) bits.push(`${TIMING[p.timing]}${p.minutes_late ? ` +${p.minutes_late}m` : ''}`);
  return bits.join('  ·  ');
}

const scoreLine = (g) => `${g.away_team} ${g.away_score}, ${g.home_team} ${g.home_score}`;

function statusLines(g) {
  const out = [];
  switch (g.status) {
    case 'scheduled': {
      const dl = games.lockDeadline(g);
      out.push('**⏳ GAME TIME NOT LOCKED**');
      if (dl && Date.now() < dl) out.push(`Lock by ${ts(dl, 'f')} for Lock In credits.`);
      break;
    }
    case 'locked': out.push(`**🔒 KICKOFF ${ts(g.locked_at, 'F')}**`, `${ts(g.locked_at, 'R')}`); break;
    case 'kicked': out.push(`**🏈 IN PROGRESS** · kicked off ${ts(g.kickoff_at, 't')}`); break;
    case 'final_pending': out.push(`**📝 FINAL: ${scoreLine(g)}**`, `Reported by ${ui.mention(g.final_by)}. Waiting on the opponent to confirm.`); break;
    case 'complete': out.push(`**✅ FINAL: ${scoreLine(g)}**`); break;
    case 'forfeit': out.push(`**⚠️ FORFEIT** · win to ${g.winner === 'away' ? g.away_team : g.home_team}`); break;
    case 'forcewin': out.push(`**⚖️ FORCE WIN** · ${g.winner === 'away' ? g.away_team : g.home_team}`); break;
    case 'sim': out.push('**🤖 SIMMED** by ruling'); break;
    case 'double_loss': out.push('**❌ DOUBLE LOSS** by ruling'); break;
    case 'unplayed': out.push('**⛔ UNPLAYED** · waiting on a staff ruling'); break;
    case 'cpu': out.push('**🤖 CPU GAME** · nothing to schedule'); break;
    default: break;
  }
  if (g.proposed_at && ['scheduled', 'locked'].includes(g.status)) {
    out.push(`🕒 ${g.status === 'locked' ? 'Audible' : 'Proposed'}: ${ts(g.proposed_at, 'F')} by ${ui.mention(g.proposed_by)}. Waiting on the opponent.`);
  }
  if (g.gotw) out.push('⭐ **GAME OF THE WEEK**');
  return out;
}

function buttonsFor(g) {
  const b = [];
  const confirm = g.proposed_at ? ui.button(`game:confirm:${g.id}:${g.proposed_at}`, g.status === 'locked' ? 'Confirm New Time' : 'Confirm Time', 'success', { emoji: '✅' }) : null;
  switch (g.status) {
    case 'scheduled':
      b.push(confirm, ui.button(`game:suggest:${g.id}`, 'Suggest Times', 'primary', { emoji: '🗓️' }), ui.button(`game:custom:${g.id}`, 'Set Time', 'secondary', { emoji: '⌨️' }));
      break;
    case 'locked':
      b.push(ui.button(`game:live:${g.id}`, "I'm Live", 'danger', { emoji: '🔴' }), ui.button(`game:kickoff:${g.id}`, 'Kickoff', 'success', { emoji: '🏈' }),
        confirm, ui.button(`game:custom:${g.id}`, 'Audible', 'secondary', { emoji: '🔁' }));
      break;
    case 'kicked':
      b.push(ui.button(`game:live:${g.id}`, "I'm Live", 'danger', { emoji: '🔴' }), ui.button(`game:final:${g.id}`, 'Final Score', 'primary', { emoji: '📝' }));
      break;
    case 'final_pending':
      b.push(ui.button(`game:finalok:${g.id}`, 'Confirm Final', 'success', { emoji: '✅' }), ui.button(`game:dispute:${g.id}`, 'Dispute', 'danger'),
        ui.button(`game:final:${g.id}`, 'Fix Score', 'secondary'));
      break;
    case 'complete':
      b.push(ui.button(`game:vod:${g.id}`, 'Add VOD', 'secondary', { emoji: '📼' }));
      break;
    default: break;
  }
  return ui.rows(b);
}

function render(gameId) {
  const ctx = games.load(gameId);
  const g = ctx.game;
  const color = { complete: BRAND.green, locked: BRAND.red, kicked: BRAND.red, final_pending: BRAND.gold, scheduled: BRAND.grey }[g.status] || BRAND.black;
  const desc = [playerLine(g, ctx.away, 'away'), playerLine(g, ctx.home, 'home'), '', ...statusLines(g)].join('\n');
  return {
    embeds: [ui.embed({
      title: `${g.league} WK ${g.week}  |  ${g.away_team.toUpperCase()} @ ${g.home_team.toUpperCase()}`,
      description: desc, color, footer: `Game #${g.id}`,
    })],
    components: buttonsFor(g),
  };
}

async function refresh(gameId) {
  const g = games.getGame(gameId);
  if (!g || !g.channel_id || !g.message_id) return;
  await api.safeEdit(g.channel_id, g.message_id, render(gameId));
}

// Message into the game's thread (or its channel if there's no thread).
async function say(gameId, payload) {
  const g = games.getGame(gameId);
  if (!g) return null;
  const target = g.thread_id || g.channel_id;
  if (!target) return null;
  try { return await api.send(target, payload); } catch (e) { console.warn(`[game ${gameId}] say: ${e.message}`); return null; }
}

async function post(gameId) {
  const g = games.getGame(gameId);
  if (!g || g.message_id || g.status === 'cpu') return null;
  const channelId = settings.channelId(g.league === 'NL' ? 'gamesNL' : 'gamesHL');
  if (!channelId) return null;
  const ctx = games.load(gameId);
  try {
    const msg = await api.send(channelId, render(gameId));
    db.run('UPDATE games SET channel_id = ?, message_id = ? WHERE id = ?', channelId, msg.id, gameId);
    const thread = await api.startThread(channelId, msg.id, `WK${g.week} ${g.away_team} @ ${g.home_team}`);
    db.run('UPDATE games SET thread_id = ? WHERE id = ?', thread.id, gameId);
    const dl = games.lockDeadline(g);
    await api.send(thread.id, {
      content: `${ui.mention(ctx.away.user_id)} ${ui.mention(ctx.home.user_id)} this is your game thread.`,
      embeds: [ui.embed({
        title: 'GAME DAY FLOW',
        description: [
          `**1. Lock it.** Tap **Suggest Times** for times you both can make, then your opponent confirms.${dl ? ` Lock by ${ts(dl, 'f')} for +${settings.credit('lockIn')} each.` : ''}`,
          `**2. Go live.** Stream starts and the bot sees it, or tap **I'm Live** at T-15.`,
          `**3. Kick off** within 5 minutes of the locked time and tap **Kickoff**. +${settings.credit('onTime')} if you're on time.`,
          `**4. Finish it.** Winner taps **Final Score**, opponent confirms. +${settings.credit('complete')} each for a full game, +${settings.credit('double')} more for The Double.`,
          '**5. Post your VOD** with **Add VOD** for Full Broadcast credit.',
        ].join('\n'),
        color: BRAND.black,
      })],
    });
    return msg;
  } catch (e) {
    console.warn(`[game ${gameId}] post failed: ${e.message}`);
    return null;
  }
}

async function postWeek(league, week) {
  let n = 0;
  for (const g of games.weekGames(league, week)) {
    if (!g.message_id) { const m = await post(g.id); if (m) n++; }
  }
  return n;
}

const paidText = (paid) => {
  const total = (paid || []).reduce((a, b) => a + b.amount, 0);
  return total ? `+${total}` : null;
};

module.exports = { render, refresh, say, post, postWeek, paidText, scoreLine, TIMING };

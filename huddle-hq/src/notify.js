'use strict';
// Turns service events into Discord posts: credit log, strike log, staff alerts, The Wire.
const { bus } = require('./bus');
const api = require('./discord/api');
const settings = require('./settings');
const ui = require('./lib/ui');
const members = require('./services/members');
const games = require('./services/games');
const { BRAND } = require('./constants');

let creditLines = [];
let lastErrorPost = 0;

async function flushCredits() {
  if (!creditLines.length) return;
  const lines = creditLines;
  creditLines = [];
  let chunk = '';
  for (const line of lines) {
    if ((chunk + line).length > 1900) { await api.post('creditLog', { content: chunk, allowed_mentions: { parse: [] } }); chunk = ''; }
    chunk += `${line}\n`;
  }
  if (chunk) await api.post('creditLog', { content: chunk, allowed_mentions: { parse: [] } });
}

function attach() {
  bus.on('credit', ({ userId, amount, reason, balance }) => {
    creditLines.push(`\`${ui.signed(amount).padStart(5)}\` <@${userId}> · ${ui.clip(reason, 90)} · bal ${balance}`);
  });

  bus.on('strike', async ({ id, userId, label, reason, total, by }) => {
    const m = members.get(userId);
    await api.post('strikeLog', {
      embeds: [ui.embed({
        title: `STRIKE #${id}  |  ${(m && m.streamer_name) || 'MEMBER'}`,
        description: `${ui.mention(userId)} · **${label}**\n${reason}\nTotal this season: **${total}**${by ? `\nIssued by ${ui.mention(by)}` : '\nIssued automatically'}`,
        color: BRAND.red, timestamp: true,
      })],
    });
    await api.dm(userId, {
      embeds: [ui.embed({
        title: 'THN STRIKE',
        description: `${label}: ${reason}\nYou have **${total}** strike${total === 1 ? '' : 's'} this season. At ${settings.limit('strikesFreeze')}, trades and Game of the Week eligibility freeze. Think it's wrong? Reply in your game thread and staff will review.`,
        color: BRAND.red,
      })],
    });
  });

  bus.on('strikeVoid', async (s) => {
    await api.post('strikeLog', { embeds: [ui.embed({ description: `Strike #${s.id} for ${ui.mention(s.user_id)} voided by ${ui.mention(s.by)}. They have ${s.total} this season.`, color: BRAND.grey })] });
  });

  bus.on('freeze', async ({ userId, total }) => {
    await api.post('staffAlerts', { embeds: [ui.embed({ title: 'TRADES FROZEN', description: `${ui.mention(userId)} reached ${total} strikes. Their trades and Prime Time eligibility are frozen until reviewed. \`/commish unfreeze\` lifts it.`, color: BRAND.gold })] });
  });

  bus.on('review', async ({ id, userId, reason }) => {
    await api.post('staffAlerts', { embeds: [ui.embed({ title: `🚩 REMOVAL REVIEW #${id}`, description: `${ui.mention(userId)} · ${reason}\nIn Season 1 this is a do-not-invite flag for next season. Close it with \`/hq review-close\`.`, color: BRAND.red })] });
  });

  bus.on('ironClock', async ({ userId }) => {
    await api.addRoleFor(userId, 'ironClock', '10-game on-time streak');
    const m = members.get(userId);
    await api.post('wire', { embeds: [ui.embed({ title: '⏱️ IRON CLOCK', description: `**${(m && m.streamer_name) || 'A THN member'}** (${ui.mention(userId)}) has started 10 straight games on time. That's what a broadcast network runs on.`, color: BRAND.silver })] });
  });

  bus.on('spoiler', async ({ gameId, userId, winnerTeam, loserTeam, winnerRecord, loserRecord }) => {
    const g = games.getGame(gameId);
    await api.post('wire', {
      embeds: [ui.embed({
        title: '🚨 SPOILER ALERT',
        description: `The **${winnerTeam}** (${winnerRecord}) just took down the **${loserTeam}** (${loserRecord})${g ? `, ${g.away_score}-${g.home_score} final` : ''}.\n${ui.mention(userId)} collects the Spoiler Bounty: +${settings.credit('spoilerBounty')}.`,
        color: BRAND.red,
      })],
    });
  });

  bus.on('clipFeatured', async (c) => {
    const m = members.get(c.user_id);
    await api.post('wire', { embeds: [ui.embed({ title: `🎬 FEATURED ON THN  |  ${c.type.toUpperCase()}`, description: `${(m && m.streamer_name) || 'THN member'} (${ui.mention(c.user_id)})\n${c.url}`, color: BRAND.gold })] });
  });

  bus.on('tradeDecided', () => { /* handled by the trades module, which has the message ids */ });

  bus.on('error', async ({ where, error }) => {
    if (Date.now() - lastErrorPost < 60000) return;
    lastErrorPost = Date.now();
    await api.post('staffAlerts', { embeds: [ui.embed({ title: 'BOT ERROR', description: `\`${where}\`\n\`\`\`${ui.clip(error && error.message, 900)}\`\`\``, color: BRAND.grey })] });
  });

  const timer = setInterval(() => { flushCredits().catch((e) => console.warn(`[credit-log] ${e.message}`)); }, 10000);
  if (timer.unref) timer.unref();
}

module.exports = { attach, flushCredits };

'use strict';
// Game day: lock times, go live, kickoff, finals, VODs, disconnects, and staff rulings.
const db = require('../db');
const settings = require('../settings');
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const { UserError } = require('../bus');
const games = require('../services/games');
const members = require('../services/members');
const availability = require('../services/availability');
const live = require('../live');
const view = require('../views/game');
const { ts, fmtIn, resolveGameTime, normalizeTz, DAY } = require('../lib/time');
const { BRAND } = require('../constants');

// ---------- helpers ----------

function findGame(i, id = null) {
  const g = id ? games.getGame(Number(id)) : games.currentGame(i.userId, i.channelId);
  if (!g) throw new UserError('You don\'t have an open game right now. Game threads appear after each advance.');
  return g;
}

function opponentOf(ctx, userId) {
  const side = games.sideOf(ctx, userId);
  if (!side) return null;
  const o = ctx[games.other(side)];
  return o ? o.user_id : null;
}

function requireOwnerOrStaff(i, ctx) {
  if (!games.sideOf(ctx, i.userId) && !i.isStaff) throw new UserError('Only the two owners in this game can do that.');
}

const memberTz = (userId) => (members.get(userId) || {}).timezone || 'PT';

// Removes the buttons from a thread message once it has been used (keeps the main game post intact).
async function retireButtons(i, g) {
  if (i.message && i.message.id !== g.message_id) await api.safeEdit(i.channelId, i.message.id, { components: [] });
}

async function announceProposal(gameId, proposerId) {
  const ctx = games.load(gameId);
  const g = ctx.game;
  const opp = opponentOf(ctx, proposerId);
  const audible = g.status === 'locked';
  const lines = [`${ui.mention(proposerId)} proposed **${ts(g.proposed_at, 'F')}** (${ts(g.proposed_at, 'R')}).`];
  if (audible) {
    const hrs = Math.floor((g.locked_at - Date.now()) / 3600000);
    lines.push(`This is an **Audible** (reschedule). ${hrs >= settings.limit('audibleNoticeHours') ? 'Enough notice, so no penalty.' : 'Under 6 hours\' notice: the proposer gets no On The Clock credits for this game and their streak resets.'}`);
  }
  lines.push(opp ? `${ui.mention(opp)}, tap **Confirm** to lock it.` : 'Either owner can confirm.');
  await view.say(gameId, {
    content: opp ? ui.mention(opp) : undefined,
    embeds: [ui.embed({ title: audible ? '🔁 AUDIBLE REQUESTED' : '🕒 KICKOFF PROPOSED', description: lines.join('\n'), color: BRAND.gold })],
    components: ui.rows([ui.button(`game:confirm:${gameId}:${g.proposed_at}`, audible ? 'Confirm New Time' : 'Confirm Time', 'success', { emoji: '✅' })]),
  });
  await view.refresh(gameId);
}

async function doPropose(i, gameId, ms) {
  const ctx = games.load(gameId);
  requireOwnerOrStaff(i, ctx);
  games.propose(gameId, i.userId, ms, { staff: i.isStaff });
  await i.defer(true);
  await announceProposal(gameId, i.userId);
  const opp = opponentOf(ctx, i.userId);
  await i.send({ embeds: [ui.ok(`Proposed ${ts(ms, 'F')}. ${opp ? `Waiting on ${ui.mention(opp)} to confirm in the game thread.` : ''}`)], ephemeral: true });
}

async function doConfirm(i, gameId, ms) {
  const r = games.confirm(gameId, i.userId, ms, { staff: i.isStaff });
  await i.deferUpdate();
  await retireButtons(i, r.game);
  let text;
  if (r.audible) {
    text = r.late
      ? `🔁 **AUDIBLE LOCKED**: new kickoff ${ts(r.game.locked_at, 'F')}.\n${r.outOfAudibles ? 'No Audibles left this season, so it counts as short notice.' : 'Short notice.'} ${ui.mention(r.proposer)} gets no On The Clock credits for this game and their streak resets.`
      : `🔁 **AUDIBLE LOCKED**: new kickoff ${ts(r.game.locked_at, 'F')}. ${ui.mention(r.proposer)} has ${r.audiblesLeft} Audible${r.audiblesLeft === 1 ? '' : 's'} left this season.`;
  } else {
    text = `🔒 **LOCKED**: kickoff ${ts(r.game.locked_at, 'F')} (${ts(r.game.locked_at, 'R')}).${r.lockIn ? ` +${settings.credit('lockIn')} Lock In credits each.` : ''}\nGo live by T-15. The bot checks you in automatically if your stream is connected to Discord, or tap **I'm Live**.`;
  }
  await view.say(gameId, { embeds: [ui.embed({ description: text, color: BRAND.red })] });
  await view.refresh(gameId);
}

async function doLive(i, gameId = null, link = null) {
  await i.defer(true);
  const res = await live.goLive(i.userId, { url: link, source: 'manual', gameId });
  const lines = [];
  lines.push(res.isNew ? '🔴 You\'re live. Your go-live alert is posted and your THN Passport code is in your DMs.' : '🔴 You\'re marked live.');
  for (const h of res.hits) {
    const paid = view.paidText(h.paid);
    lines.push(`Checked in for **${games.label(h.game)}**${paid ? ` (${paid} credits)` : ''}.`);
  }
  if (!res.hits.length) {
    const g = gameId ? games.getGame(gameId) : games.currentGame(i.userId);
    if (g && g.status === 'locked' && g.locked_at) lines.push(`Check-in for **${games.label(g)}** opens 2 hours before kickoff (${ts(g.locked_at - 2 * 3600000, 'f')}).`);
    else if (g && g.status === 'scheduled') lines.push(`Your game **${games.label(g)}** isn't locked yet. Live time counts once you kick off.`);
  }
  if (!res.url) lines.push('Tip: save your stream link with `/stream` so alerts include a Watch button.');
  await i.send({ embeds: [ui.ok(lines.join('\n'))], ephemeral: true });
}

function timingLine(userId, t, paid) {
  const p = view.paidText(paid);
  if (!t) return null;
  if (t.timing === 'ontime') return `${ui.mention(userId)} ✅ on time${p ? ` · ${p}` : ''}`;
  if (t.timing === 'late') return `${ui.mention(userId)} 🕒 ${t.late} min late · no on-time credit, streak reset`;
  return `${ui.mention(userId)} 🟠 ${t.late} min late · strike (${t.strike ? t.strike.total : '?'} this season)`;
}

async function doKickoff(i, gameId) {
  const r = games.kickoff(gameId, i.userId, { staff: i.isStaff });
  await i.defer(true);
  const lines = [`🏈 **KICKOFF** ${ts(r.game.kickoff_at, 't')}`];
  if (!r.locked) lines.push('This game wasn\'t locked, so On The Clock credits don\'t apply. Final Whistle credits still do.');
  for (const s of games.SIDES) {
    const p = r[s];
    const line = timingLine(p.user_id, r.timings[s], r.paid[s]);
    if (line) lines.push(line);
    if (!p.verified) lines.push(`${ui.mention(p.user_id)} isn't checked in live yet. Tap **I'm Live** or use \`/golive\` so this game earns credits.`);
  }
  await view.say(gameId, { embeds: [ui.embed({ description: lines.join('\n'), color: BRAND.red })] });
  await view.refresh(gameId);
  await i.send({ embeds: [ui.ok('Kickoff logged. Good luck.')], ephemeral: true });
}

function finalModal(g) {
  return ui.modal(`game:finalm:${g.id}`, 'FINAL SCORE', [
    { id: 'away', label: `${g.away_team} (away) score`, placeholder: '0', max: 3 },
    { id: 'home', label: `${g.home_team} (home) score`, placeholder: '0', max: 3 },
  ]);
}

async function doFinal(i, gameId, awayScore, homeScore) {
  const r = games.submitFinal(gameId, i.userId, awayScore, homeScore, { staff: i.isStaff });
  await i.defer(true);
  if (r.game.status === 'complete') {
    await announceComplete(gameId, r);
    await i.send({ embeds: [ui.ok('Final recorded and confirmed.')], ephemeral: true });
    return;
  }
  const ctx = games.load(gameId);
  const opp = opponentOf(ctx, i.userId);
  await view.say(gameId, {
    content: opp ? ui.mention(opp) : undefined,
    embeds: [ui.embed({
      title: '📝 FINAL REPORTED',
      description: `**${view.scoreLine(r.game)}**\nReported by ${ui.mention(i.userId)}. ${opp ? `${ui.mention(opp)}, confirm or dispute.` : ''} It auto-confirms in ${settings.limit('finalAutoConfirmHours')} hours.`,
      color: BRAND.gold,
    })],
    components: ui.rows([ui.button(`game:finalok:${gameId}`, 'Confirm Final', 'success', { emoji: '✅' }), ui.button(`game:dispute:${gameId}`, 'Dispute', 'danger')]),
  });
  await view.refresh(gameId);
  await i.send({ embeds: [ui.ok('Score sent to your opponent to confirm.')], ephemeral: true });
}

async function announceComplete(gameId, r) {
  const lines = [`✅ **FINAL: ${view.scoreLine(r.game)}**${r.auto ? ' (auto-confirmed)' : ''}`];
  for (const s of games.SIDES) {
    const p = view.paidText(r.paid[s]);
    if (p) lines.push(`${ui.mention(r[s].user_id)} ${p} credits`);
  }
  for (const s of r.unverified || []) {
    lines.push(`${ui.mention(r[s].user_id)} has no live check-in for this game, so no credits yet. Played off stream? Ask staff to verify your VOD.`);
  }
  if (r.spoiler) lines.push(`🚨 **SPOILER BOUNTY**: ${r.spoiler.winnerTeam} (${r.spoiler.winnerRecord}) took down ${r.spoiler.loserTeam} (${r.spoiler.loserRecord}). +${settings.credit('spoilerBounty')}`);
  lines.push('Post your VOD with **Add VOD** for Full Broadcast credit, and send your best moment to `/clip submit`.');
  await view.say(gameId, { embeds: [ui.embed({ description: lines.join('\n'), color: BRAND.green })] });
  await view.refresh(gameId);
}

async function doConfirmFinal(i, gameId) {
  const r = games.confirmFinal(gameId, i.userId, { staff: i.isStaff });
  await i.deferUpdate();
  await retireButtons(i, r.game);
  await announceComplete(gameId, r);
}

async function doVod(i, gameId, url) {
  const u = members.normalizeUrl(url);
  if (!u) throw new UserError('That VOD link doesn\'t look right.');
  const r = games.addVod(gameId, i.userId, u, { staff: i.isStaff });
  const paid = view.paidText(r.paid);
  await i.reply({ embeds: [ui.ok(`VOD saved.${paid ? ` ${paid} Full Broadcast credits.` : r.game.status === 'complete' ? '' : ' Credits pay once the final is confirmed.'}`)], ephemeral: true });
  await view.say(gameId, `📼 ${ui.mention(i.userId)} posted the VOD: ${u}`);
}

function suggestReply(i, gameId) {
  const ctx = games.load(gameId);
  requireOwnerOrStaff(i, ctx);
  if (!ctx.away || !ctx.home) throw new UserError('This is a CPU game.');
  if (!['scheduled', 'locked'].includes(ctx.game.status)) throw new UserError('This game is already underway.');
  const now = Date.now();
  const until = games.latestKickoff() || now + 2 * DAY;
  const a = members.get(ctx.away.user_id);
  const h = members.get(ctx.home.user_id);
  const { slots, aSet, bSet } = availability.suggest(a, h, now, until);
  const tz = memberTz(i.userId);
  const lines = [];
  if (slots.length) {
    lines.push('Times you can both make, before the deadline:');
    for (const ms of slots) lines.push(`• ${ts(ms, 'F')} (${ts(ms, 'R')})`);
  } else {
    lines.push('I couldn\'t find overlapping availability before the deadline. Set a custom time and sort it out in the thread.');
  }
  if (!aSet) lines.push(`\n${ui.mention(ctx.away.user_id)} hasn't set availability, so I used 5 to 11 PM their time.`);
  if (!bSet) lines.push(`${aSet ? '\n' : ''}${ui.mention(ctx.home.user_id)} hasn't set availability, so I used 5 to 11 PM their time.`);
  if (!aSet || !bSet) lines.push('`/availability` fixes that in 10 seconds.');
  const latest = games.latestKickoff();
  if (latest) lines.push(`\nLatest kickoff: ${ts(latest, 'F')}.`);
  return {
    embeds: [ui.embed({ title: `GAME SCHEDULER  |  ${games.label(ctx.game).toUpperCase()}`, description: lines.join('\n'), color: BRAND.black })],
    components: ui.rows([
      ...slots.map((ms) => ui.button(`game:pick:${gameId}:${ms}`, fmtIn(ms, tz), 'primary')),
      ui.button(`game:custom:${gameId}`, 'Custom time', 'secondary', { emoji: '⌨️' }),
    ]),
    ephemeral: true,
  };
}

function customModal(gameId, userId) {
  return ui.modal(`game:timem:${gameId}`, 'SET KICKOFF TIME', [
    { id: 'day', label: 'Day', placeholder: 'today, tomorrow, Sat, or 10/14', value: 'today', max: 20 },
    { id: 'time', label: 'Kickoff time', placeholder: '8:30 PM', max: 12 },
    { id: 'tz', label: 'Time zone (PT, MT, CT, ET)', value: memberTz(userId), max: 20 },
  ]);
}

function parseTimeInput(day, clock, tzText) {
  const tz = normalizeTz(tzText) || 'PT';
  const r = resolveGameTime(day, clock, tz);
  if (r.error) throw new UserError(r.error);
  return r.ms;
}

// ---------- rulings ----------

function rulingButtons(ctx, { noShowSide = null } = {}) {
  const g = ctx.game;
  const btns = [];
  if (noShowSide) {
    const winner = games.other(noShowSide);
    btns.push(ui.button(`rule:ns:${g.id}:${winner}`, `No-show: win to ${g[`${winner}_team`]}`, 'danger'));
  }
  btns.push(
    ui.button(`rule:fw:${g.id}:away`, `Win: ${g.away_team}`, 'primary'),
    ui.button(`rule:fw:${g.id}:home`, `Win: ${g.home_team}`, 'primary'),
    ui.button(`rule:sim:${g.id}`, 'Sim', 'secondary'),
    ui.button(`rule:simx:${g.id}`, 'Sim + strikes', 'secondary'),
    ui.button(`rule:dl:${g.id}`, 'Double loss', 'danger'),
  );
  return ui.rows(btns);
}

function rulingSummary(r) {
  const g = r.game;
  const what = {
    forcewin: `⚖️ **FORCE WIN**: ${g.winner === 'away' ? g.away_team : g.home_team}`,
    forfeit: `⚠️ **FORFEIT**: win to ${g.winner === 'away' ? g.away_team : g.home_team}`,
    sim: '🤖 **SIMMED** by ruling',
    double_loss: '❌ **DOUBLE LOSS** by ruling',
  }[g.status] || `Ruling: ${g.status}`;
  const lines = [what];
  for (const s of r.struck || []) lines.push(`Strike to ${ui.mention(r[s.side].user_id)} (${s.total} this season).`);
  for (const side of games.SIDES) {
    const p = view.paidText(r.paid && r.paid[side]);
    if (p) lines.push(`${ui.mention(r[side].user_id)} ${p} credits`);
  }
  return lines.join('\n');
}

async function announceRuling(gameId, r, by) {
  await view.say(gameId, { embeds: [ui.embed({ description: `${rulingSummary(r)}\nRuled by ${ui.mention(by)}.`, color: BRAND.silver })] });
  await view.refresh(gameId);
}

async function rulingButton(i) {
  if (!i.isStaff) throw new UserError('Only staff can make rulings.');
  const [, action, id, side] = i.args;
  const gameId = Number(id);
  let r;
  if (action === 'fw') r = games.forceWin(gameId, side, { strike: true, kind: 'unplayed', by: i.userId });
  else if (action === 'ns') r = games.forceWin(gameId, side, { strike: true, kind: 'noshow', by: i.userId });
  else if (action === 'sim') r = games.sim(gameId, { strikeBoth: false, by: i.userId });
  else if (action === 'simx') r = games.sim(gameId, { strikeBoth: true, by: i.userId });
  else if (action === 'dl') r = games.doubleLoss(gameId, { by: i.userId });
  else throw new UserError('Unknown ruling.');
  await i.update({ embeds: [...((i.message && i.message.embeds) || []).slice(0, 1).map(cleanEmbed), ui.embed({ description: `${rulingSummary(r)}\nRuled by ${ui.mention(i.userId)}.`, color: BRAND.silver })], components: [] });
  await announceRuling(gameId, r, i.userId);
}

// Strip read-only fields Discord returns on embeds before sending them back.
function cleanEmbed(e) {
  const out = { title: e.title, description: e.description, color: e.color, fields: e.fields, url: e.url };
  if (e.footer) out.footer = { text: e.footer.text };
  return JSON.parse(JSON.stringify(out));
}

async function gameAutocomplete(i) {
  const q = String((i.focused() || {}).value || '').toLowerCase();
  const rows = db.all(`SELECT * FROM games WHERE season = ? AND status <> 'cpu'
    ORDER BY CASE WHEN status IN ('unplayed','final_pending','kicked','locked','scheduled') THEN 0 ELSE 1 END, week DESC, id DESC LIMIT 150`, settings.season());
  const choices = rows.map((g) => ({ name: `#${g.id} ${g.league} W${g.week} ${g.away_team} @ ${g.home_team} (${g.status})`, value: g.id }))
    .filter((c) => !q || c.name.toLowerCase().includes(q));
  await i.autocomplete(choices);
}

function sideForUser(ctx, userId) {
  const s = games.sideOf(ctx, userId);
  if (!s) throw new UserError(`${ui.mention(userId)} isn't in that game.`);
  return s;
}

async function rulingCommand(i) {
  if (!i.isStaff) throw new UserError('Only staff can make rulings.');
  const gameId = i.int('game');
  const ctx = games.load(gameId);
  let r;
  switch (i.sub) {
    case 'forcewin': r = games.forceWin(gameId, sideForUser(ctx, i.get('winner')), { strike: i.bool('strike') !== false, kind: 'unplayed', by: i.userId }); break;
    case 'noshow': r = games.forceWin(gameId, games.other(sideForUser(ctx, i.get('member'))), { strike: true, kind: 'noshow', by: i.userId }); break;
    case 'ragequit': r = games.rageQuit(gameId, sideForUser(ctx, i.get('member')), { by: i.userId }); break;
    case 'sim': r = games.sim(gameId, { strikeBoth: !!i.bool('strike_both'), by: i.userId }); break;
    case 'doubleloss': r = games.doubleLoss(gameId, { by: i.userId }); break;
    case 'settime': {
      const res = resolveGameTime(i.str('day'), i.str('time'), i.str('timezone') || 'PT');
      if (res.error) throw new UserError(res.error);
      games.assignTime(gameId, res.ms);
      await view.say(gameId, { embeds: [ui.embed({ description: `🔒 **KICKOFF SET BY STAFF**: ${ts(res.ms, 'F')} (${ts(res.ms, 'R')}).`, color: BRAND.red })] });
      await view.refresh(gameId);
      return i.reply({ embeds: [ui.ok(`Game #${gameId} locked for ${ts(res.ms, 'F')}.`)], ephemeral: true });
    }
    case 'verify': {
      const side = sideForUser(ctx, i.get('member'));
      const v = games.verifyLive(gameId, side);
      const paid = view.paidText(v.paid);
      await view.say(gameId, `✅ Staff verified ${ui.mention(i.get('member'))} was live for this game.${paid ? ` ${paid} credits.` : ''}`);
      await view.refresh(gameId);
      return i.reply({ embeds: [ui.ok(`Verified.${paid ? ` Paid ${paid}.` : ''}`)], ephemeral: true });
    }
    case 'final': {
      const sub = games.submitFinal(gameId, i.userId, i.int('away_score'), i.int('home_score'), { staff: true });
      const done = sub.game.status === 'complete' ? sub : games.confirmFinal(gameId, i.userId, { staff: true });
      await announceComplete(gameId, done);
      return i.reply({ embeds: [ui.ok(`Final recorded: ${view.scoreLine(done.game)}.`)], ephemeral: true });
    }
    case 'reopen': {
      games.reopen(gameId);
      await view.say(gameId, `↩️ Staff reopened this game. Credits already paid stay paid.`);
      await view.refresh(gameId);
      return i.reply({ embeds: [ui.ok(`Game #${gameId} reopened.`)], ephemeral: true });
    }
    default: throw new UserError('Unknown ruling.');
  }
  await i.reply({ embeds: [ui.ok(rulingSummary(r))], ephemeral: true });
  await announceRuling(gameId, r, i.userId);
}

const gameOpt = () => b.int('game', 'Game (start typing a team)', { required: true, autocomplete: true });

module.exports = {
  commands: [
    {
      def: b.command('game', 'Your game: lock a time, kick off, report the final', [
        b.sub('time', 'Propose a kickoff time (or an Audible if already locked)', [
          b.str('day', 'Which day', { required: true, choices: b.dayChoices }),
          b.str('time', 'Kickoff time, like 8:30 PM', { required: true, max: 12 }),
          b.str('timezone', 'Time zone of that time (default: yours)', { choices: b.tzChoices }),
        ]),
        b.sub('suggest', 'Kickoff times you and your opponent can both make'),
        b.sub('kickoff', 'Log kickoff (do it at the coin toss)'),
        b.sub('final', 'Report the final score', [
          b.int('my_score', 'Your score', { required: true, min: 0, max: 199 }),
          b.int('opp_score', 'Opponent score', { required: true, min: 0, max: 199 }),
        ]),
        b.sub('vod', 'Post your VOD for Full Broadcast credit', [b.str('link', 'VOD link', { required: true, max: 300 })]),
        b.sub('dc', 'Report a disconnect (within 10 minutes)', [
          b.attachment('screenshot', 'Screenshot showing the score and clock', { required: true }),
          b.str('note', 'Quarter, time left, who has the ball', { max: 200 }),
        ]),
        b.sub('info', 'Show your current game'),
      ]),
      run: async (i) => {
        const g = findGame(i);
        const ctx = games.load(g.id);
        switch (i.sub) {
          case 'time': {
            const res = resolveGameTime(i.str('day'), i.str('time'), i.str('timezone') || memberTz(i.userId));
            if (res.error) throw new UserError(res.error);
            return doPropose(i, g.id, res.ms);
          }
          case 'suggest': return i.reply(suggestReply(i, g.id));
          case 'kickoff': return doKickoff(i, g.id);
          case 'final': {
            const side = games.sideOf(ctx, i.userId);
            if (!side) throw new UserError('Use this in a game you play in. Staff can use /ruling final.');
            const mine = i.int('my_score');
            const theirs = i.int('opp_score');
            return doFinal(i, g.id, side === 'away' ? mine : theirs, side === 'away' ? theirs : mine);
          }
          case 'vod': return doVod(i, g.id, i.str('link'));
          case 'dc': {
            requireOwnerOrStaff(i, ctx);
            const shot = i.attachment('screenshot');
            games.setFlags(g.id, { dc: (games.flags(g).dc || 0) + 1 });
            await view.say(g.id, { embeds: [ui.embed({ title: '📡 DISCONNECT REPORTED', description: `${ui.mention(i.userId)}: ${i.str('note') || 'no note'}\nFinish the remaining time with the league resume rule. It still counts as Complete if it's finished before the advance.`, image: shot && shot.url, color: BRAND.gold })] });
            await api.post('staffAlerts', { embeds: [ui.embed({ title: 'DISCONNECT', description: `${games.fullLabel(g)}\nReported by ${ui.mention(i.userId)}: ${i.str('note') || 'no note'}`, image: shot && shot.url, color: BRAND.gold })] });
            return i.reply({ embeds: [ui.ok('Disconnect logged in your game thread. Finish the remaining time and report the final as usual.')], ephemeral: true });
          }
          case 'info': return i.reply({ ...view.render(g.id), ephemeral: true });
          default: throw new UserError('Unknown option.');
        }
      },
    },
    {
      def: b.command('golive', 'Check in live (use this for TikTok, or any stream the bot can\'t see)', [
        b.str('link', 'Stream link (default: your saved link)', { max: 200 }),
      ]),
      run: (i) => doLive(i, null, i.str('link')),
    },
    {
      def: b.command('ruling', 'Staff rulings on games', [
        b.sub('forcewin', 'Force win (strike to the other side by default)', [gameOpt(), b.user('winner', 'Who gets the win', { required: true }), b.bool('strike', 'Strike the other side (default yes)')]),
        b.sub('noshow', 'No-show: force win to the opponent, no-show strike', [gameOpt(), b.user('member', 'Who no-showed', { required: true })]),
        b.sub('ragequit', 'Rage quit: forfeit, strike, opponent gets Complete credit', [gameOpt(), b.user('member', 'Who quit', { required: true })]),
        b.sub('sim', 'Sim the game', [gameOpt(), b.bool('strike_both', 'Strike both owners')]),
        b.sub('doubleloss', 'Double loss with strikes to both', [gameOpt()]),
        b.sub('settime', 'Assign a default kickoff time (no Lock In credit)', [gameOpt(),
          b.str('day', 'Which day', { required: true, choices: b.dayChoices }), b.str('time', 'Time, like 8:30 PM', { required: true, max: 12 }),
          b.str('timezone', 'Time zone (default PT)', { choices: b.tzChoices })]),
        b.sub('verify', 'Mark a player as live for a game (after checking the VOD)', [gameOpt(), b.user('member', 'Player', { required: true })]),
        b.sub('final', 'Record and confirm a final score', [gameOpt(),
          b.int('away_score', 'Away team score', { required: true, min: 0, max: 199 }), b.int('home_score', 'Home team score', { required: true, min: 0, max: 199 })]),
        b.sub('reopen', 'Undo a result so the game can be played or ruled again', [gameOpt()]),
      ], 'staff'),
      run: rulingCommand,
      autocomplete: gameAutocomplete,
    },
  ],
  buttons: {
    'game:suggest': (i) => i.reply(suggestReply(i, Number(i.args[2]))),
    'game:pick': (i) => doPropose(i, Number(i.args[2]), Number(i.args[3])),
    'game:custom': async (i) => {
      const ctx = games.load(Number(i.args[2]));
      requireOwnerOrStaff(i, ctx);
      await i.showModal(customModal(ctx.game.id, i.userId));
    },
    'game:confirm': (i) => doConfirm(i, Number(i.args[2]), Number(i.args[3])),
    'game:live': (i) => doLive(i, Number(i.args[2])),
    'game:kickoff': (i) => doKickoff(i, Number(i.args[2])),
    'game:final': async (i) => {
      const ctx = games.load(Number(i.args[2]));
      requireOwnerOrStaff(i, ctx);
      await i.showModal(finalModal(ctx.game));
    },
    'game:finalok': (i) => doConfirmFinal(i, Number(i.args[2])),
    'game:dispute': async (i) => {
      const gameId = Number(i.args[2]);
      const r = games.dispute(gameId, i.userId);
      await i.reply({ embeds: [ui.info('Dispute sent to staff. Post your screenshot or VOD timestamp in this thread.')], ephemeral: true });
      await view.say(gameId, `⚠️ ${ui.mention(i.userId)} disputed the reported score. Staff will rule. Post screenshots here.`);
      await api.post('staffAlerts', { embeds: [ui.embed({ title: 'SCORE DISPUTE', description: `${games.fullLabel(r.game)}\nReported: **${view.scoreLine(r.game)}** by ${ui.mention(r.game.final_by)}\nDisputed by ${ui.mention(i.userId)}\nFix with \`/ruling final\`.${r.game.thread_id ? `\nThread: <#${r.game.thread_id}>` : ''}`, color: BRAND.gold })] });
    },
    'game:vod': async (i) => {
      const g = games.getGame(Number(i.args[2]));
      await i.showModal(ui.modal(`game:vodm:${g.id}`, 'ADD YOUR VOD', [{ id: 'url', label: 'VOD link', placeholder: 'https://...', max: 300 }]));
    },
    'game:fwreq': async (i) => {
      const gameId = Number(i.args[2]);
      const ctx = games.load(gameId);
      const side = games.sideOf(ctx, i.userId);
      if (!side) throw new UserError('Only the owner who showed up can request a force-win.');
      await api.post('staffAlerts', {
        embeds: [ui.embed({ title: 'FORCE-WIN REQUEST', description: `${games.fullLabel(ctx.game)}\n${ui.mention(i.userId)} was on time and requests a force-win. Kickoff was ${ts(ctx.game.locked_at, 'f')}.`, color: BRAND.gold })],
        components: rulingButtons(ctx, { noShowSide: games.other(side) }),
      });
      await i.reply({ embeds: [ui.ok('Request sent to staff.')], ephemeral: true });
    },
    rule: rulingButton,
  },
  modals: {
    'game:timem': (i) => doPropose(i, Number(i.args[2]), parseTimeInput(i.field('day'), i.field('time'), i.field('tz'))),
    'game:finalm': (i) => {
      const away = Number(i.field('away'));
      const home = Number(i.field('home'));
      if (!Number.isInteger(away) || !Number.isInteger(home)) throw new UserError('Scores must be whole numbers.');
      return doFinal(i, Number(i.args[2]), away, home);
    },
    'game:vodm': (i) => doVod(i, Number(i.args[2]), i.field('url')),
  },
  rulingButtons,
  announceComplete,
  cleanEmbed,
};

'use strict';
// The Trade Desk.
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const settings = require('../settings');
const { UserError } = require('../bus');
const trades = require('../services/trades');
const { ts } = require('../lib/time');
const { BRAND, LEAGUES } = require('../constants');

const STATUS = {
  pending_partner: '⏳ Waiting on the other team',
  voting: '🗳️ Committee voting',
  approved: '✅ Approved',
  rejected: '❌ Rejected by committee',
  declined: '🚫 Declined',
  cancelled: '🚫 Withdrawn',
};

function tradeEmbed(t, { title } = {}) {
  const c = trades.tally(t.id);
  const fields = [
    { name: `${t.from_team} send`, value: t.sending, inline: true },
    { name: `${t.to_team} send`, value: t.receiving, inline: true },
    { name: `WHY: ${t.from_team}`, value: t.why_from || '—' },
  ];
  if (t.why_to) fields.push({ name: `WHY: ${t.to_team}`, value: t.why_to });
  if (t.status === 'voting') fields.push({ name: 'Votes', value: `✅ ${c.yes}  ·  ❌ ${c.no}  ·  auto-passes ${ts(t.voting_at + settings.limit('tradeVoteHours') * 3600000, 'R')} without a majority` });
  return ui.embed({
    title: title || `TRADE #${t.id}  |  ${t.from_team.toUpperCase()} ⇄ ${t.to_team.toUpperCase()}`,
    description: `${ui.mention(t.from_user)} ⇄ ${ui.mention(t.to_user)} · ${LEAGUES[t.league]} WK ${t.week}\n**${STATUS[t.status] || t.status}**`,
    fields, color: t.status === 'approved' ? BRAND.green : t.status === 'voting' ? BRAND.gold : BRAND.grey,
  });
}

function wireEmbed(t) {
  const fields = [
    { name: `${t.from_team.toUpperCase()} GET`, value: t.receiving, inline: true },
    { name: `${t.to_team.toUpperCase()} GET`, value: t.sending, inline: true },
    { name: `${t.from_team} on the deal`, value: `"${t.why_from}"` },
    { name: `${t.to_team} on the deal`, value: `"${t.why_to || '—'}"` },
  ];
  if (t.grade_from || t.grade_to) fields.push({ name: 'TRADE GRADES', value: `${t.from_team}: **${t.grade_from || '—'}**  ·  ${t.to_team}: **${t.grade_to || '—'}**` });
  return ui.embed({
    title: `🚨 BREAKING  |  TRADE WIRE`,
    description: `The **${t.from_team}** (${ui.mention(t.from_user)}) and **${t.to_team}** (${ui.mention(t.to_user)}) have agreed to a deal.`,
    fields, footer: `${LEAGUES[t.league]} · Trade #${t.id}`, color: BRAND.red, timestamp: true,
  });
}

async function refreshDesk(t) {
  if (t.desk_channel && t.desk_message) await api.safeEdit(t.desk_channel, t.desk_message, { embeds: [tradeEmbed(t)], components: deskButtons(t) });
  if (t.vote_channel && t.vote_message) await api.safeEdit(t.vote_channel, t.vote_message, { embeds: [tradeEmbed(t)], components: t.status === 'voting' ? voteButtons(t) : [] });
}

const deskButtons = (t) => (t.status === 'pending_partner'
  ? ui.rows([ui.button(`trade:accept:${t.id}`, 'Accept', 'success'), ui.button(`trade:decline:${t.id}`, 'Decline', 'danger'), ui.button(`trade:withdraw:${t.id}`, 'Withdraw', 'secondary')])
  : t.status === 'voting' ? ui.rows([ui.button(`trade:withdraw:${t.id}`, 'Withdraw', 'secondary')]) : []);

const voteButtons = (t) => ui.rows([ui.button(`trade:vote:${t.id}:yes`, 'Approve', 'success'), ui.button(`trade:vote:${t.id}:no`, 'Reject', 'danger')]);

// Called when a vote decides it, or when the 24-hour window auto-passes it.
async function onDecided(t, { auto = false } = {}) {
  await refreshDesk(t);
  if (t.status === 'approved') {
    const msg = await api.post('wire', { content: `${ui.mention(t.from_user)} ${ui.mention(t.to_user)}`, embeds: [wireEmbed(t)] });
    if (msg) trades.setMessage(t.id, 'wire', msg.channel_id, msg.id);
    const note = `Trade #${t.id} (${t.from_team} ⇄ ${t.to_team}) is **approved**${auto ? ' (no majority in time, so it passed automatically)' : ''}. Process it in Franchise Hub / the game file.`;
    await api.post('staffAlerts', { embeds: [ui.ok(note)] });
    for (const u of [t.from_user, t.to_user]) await api.dm(u, { embeds: [ui.ok(`Trade #${t.id} with the ${u === t.from_user ? t.to_team : t.from_team} was approved.`, 'TRADE APPROVED')] });
  } else if (t.status === 'rejected') {
    for (const u of [t.from_user, t.to_user]) await api.dm(u, { embeds: [ui.info(`Trade #${t.id} was rejected by the committee. The bar is: would a real NFL GM make this deal for his team's situation?`, 'TRADE REJECTED')] });
  }
}

async function tradeButton(i) {
  const [, action, id, value] = i.args;
  const tradeId = Number(id);
  if (action === 'accept') {
    const t = trades.get(tradeId);
    if (!t || t.to_user !== i.userId) throw new UserError('Only the other team can accept this trade.');
    return i.showModal(ui.modal(`trade:acceptm:${tradeId}`, 'ACCEPT TRADE', [{ id: 'why', label: 'Your WHY: one line on why this helps you', paragraph: true, max: 300 }]));
  }
  if (action === 'decline' || action === 'withdraw') {
    const t = trades.decline(tradeId, i.userId, { staff: i.isStaff });
    await i.deferUpdate();
    await refreshDesk(t);
    return null;
  }
  if (action === 'vote') {
    if (!i.isStaffOr('committee')) throw new UserError('Only the trade committee votes on trades.');
    const r = trades.vote(tradeId, i.userId, value);
    await i.reply({ embeds: [ui.ok(`Vote recorded: ${value === 'yes' ? 'approve' : 'reject'}. Current: ✅ ${r.yes} · ❌ ${r.no}`)], ephemeral: true });
    await refreshDesk(r.trade);
    if (['approved', 'rejected'].includes(r.trade.status)) await onDecided(r.trade);
    return null;
  }
  throw new UserError('Unknown trade action.');
}

async function acceptModal(i) {
  const t = trades.accept(Number(i.args[2]), i.userId, i.field('why'));
  await i.defer(true);
  const committee = settings.roleId('committee');
  const msg = await api.post('tradeCommittee', {
    content: committee ? `<@&${committee}> new trade to review.` : undefined,
    allowed_mentions: { parse: ['roles'] },
    embeds: [tradeEmbed(t), ui.info('Approve if a real NFL GM would make this deal for his team\'s situation. Check rating, age, dev trait, contract and position. 2 votes decide it.')],
    components: voteButtons(t),
  });
  if (msg) trades.setMessage(t.id, 'vote', msg.channel_id, msg.id);
  await refreshDesk(trades.get(t.id));
  await i.send({ embeds: [ui.ok('Accepted. The trade committee has it now.')], ephemeral: true });
}

async function proposeModal(i) {
  const partner = i.args[2];
  const t = trades.propose(i.userId, partner, { sending: i.field('send'), receiving: i.field('get'), why: i.field('why') });
  await i.defer(true);
  const msg = await api.post('tradeDesk', { content: `${ui.mention(partner)}, the **${t.from_team}** sent you a trade.`, embeds: [tradeEmbed(t)], components: deskButtons(t) });
  if (msg) trades.setMessage(t.id, 'desk', msg.channel_id, msg.id);
  else await api.dm(partner, { embeds: [tradeEmbed(t)] });
  await i.send({ embeds: [ui.ok(`Trade #${t.id} sent to ${ui.mention(partner)}.`)], ephemeral: true });
}

module.exports = {
  commands: [
    {
      def: b.command('tradedesk', 'The Trade Desk: propose trades, see yours, grade deals', [
        b.sub('propose', 'Send a trade offer', [b.user('partner', 'The team you\'re trading with', { required: true })]),
        b.sub('mine', 'Your recent trades'),
        b.sub('grade', 'Analyst desk: grade a completed trade', [b.int('id', 'Trade number', { required: true, min: 1 }),
          b.str('team', 'Which side', { required: true, choices: [{ name: 'Proposing team', value: 'from' }, { name: 'Receiving team', value: 'to' }] }),
          b.str('grade', 'Grade', { required: true, choices: ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'].map((g) => ({ name: g, value: g })) })]),
      ]),
      run: async (i) => {
        if (i.sub === 'propose') {
          const partner = i.get('partner');
          if (partner === i.userId) throw new UserError('Pick the other team\'s owner.');
          return i.showModal(ui.modal(`trade:proposem:${partner}`, 'PROPOSE A TRADE', [
            { id: 'send', label: 'You send', paragraph: true, placeholder: 'QB J. Smith (84 OVR, 26), 2027 2nd', max: 500 },
            { id: 'get', label: 'You receive', paragraph: true, placeholder: 'WR D. Jones (88 OVR, 24)', max: 500 },
            { id: 'why', label: 'Your WHY: one line', paragraph: true, placeholder: 'Contending now, need a WR1 for the playoff push', max: 300 },
          ]));
        }
        if (i.sub === 'mine') {
          const list = trades.forUser(i.userId);
          return i.reply({ embeds: [ui.embed({ title: 'YOUR TRADES', description: list.length ? list.map((t) => `#${t.id} ${t.from_team} ⇄ ${t.to_team} · ${STATUS[t.status] || t.status}`).join('\n') : 'No trades yet.', color: BRAND.black })], ephemeral: true });
        }
        if (!i.isStaffOr('media', 'committee')) throw new UserError('Only the Analyst Desk (Media Team) grades trades.');
        const t = trades.grade(i.int('id'), i.str('team'), i.str('grade'));
        if (!t) throw new UserError('Trade not found.');
        if (t.wire_channel && t.wire_message) await api.safeEdit(t.wire_channel, t.wire_message, { embeds: [wireEmbed(t)] });
        return i.reply({ embeds: [ui.ok(`Graded trade #${t.id}.`)], ephemeral: true });
      },
    },
  ],
  buttons: { trade: tradeButton },
  modals: { 'trade:acceptm': acceptModal, 'trade:proposem': proposeModal },
  onDecided,
};

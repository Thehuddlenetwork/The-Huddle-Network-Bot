'use strict';
// Credits, the shop, and strikes.
const settings = require('../settings');
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const { UserError } = require('../bus');
const credits = require('../services/credits');
const shop = require('../services/shop');
const strikes = require('../services/strikes');
const members = require('../services/members');
const { ts, weekStart } = require('../lib/time');
const { BRAND, CREDITS } = require('../constants');

function balanceEmbed(userId) {
  const m = members.get(userId);
  const hist = credits.history(userId, 8);
  const lines = hist.length ? hist.map((h) => `\`${ui.signed(h.amount).padStart(5)}\` ${ui.clip(h.reason, 70)}`).join('\n') : 'No credits yet. Lock in, go live on time, finish your games.';
  return ui.embed({
    title: `${((m && m.streamer_name) || 'YOUR').toUpperCase()}  |  ${credits.balance(userId)} CREDITS`,
    description: `**This week:** +${credits.earnedSince(userId, weekStart(Date.now()))}\n\n${lines}`,
    footer: 'Spend them with /shop',
    color: BRAND.gold,
  });
}

function leaderboardEmbed(period) {
  const since = period === 'week' ? weekStart(Date.now()) : period === 'season' ? settings.getInt('season_started_at', 0) : 0;
  const rows = credits.leaderboard(15, since);
  const medal = ['🥇', '🥈', '🥉'];
  const desc = rows.length ? rows.map((r, n) => `${medal[n] || `**${n + 1}.**`} ${r.streamer_name || ui.mention(r.user_id)} · ${r.total}`).join('\n') : 'Nobody has earned credits yet.';
  return ui.embed({ title: `CREDITS LEADERBOARD  |  ${period === 'week' ? 'THIS WEEK' : period === 'season' ? 'THIS SEASON' : 'ALL TIME'}`, description: desc, color: BRAND.gold });
}

function earnGuide() {
  const keys = ['lockIn', 'onTime', 'complete', 'double', 'fullBroadcast', 'streak3', 'streak5', 'streak10', 'completeWeek', 'completeStreak8',
    'cleanDivision', 'cleanAdvance', 'clipAccepted', 'clipFeatured', 'clipOfWeek', 'scoutReport', 'raid', 'event', 'academyLevel', 'spoilerBounty'];
  return ui.embed({
    title: 'HOW TO EARN CREDITS',
    description: keys.filter((k) => settings.credit(k) > 0).map((k) => `\`+${String(settings.credit(k)).padEnd(3)}\` ${CREDITS[k][1]}`).join('\n'),
    color: BRAND.black,
  });
}

function shopEmbed() {
  const list = shop.items();
  return ui.embed({
    title: 'THE CREDIT SHOP',
    description: list.length ? list.map((x) => `**#${x.id} ${x.name}** · ${x.cost} credits${x.stock >= 0 ? ` · ${x.stock} left` : ''}\n${x.description || ''}`).join('\n\n') : 'The shop is empty right now.',
    footer: 'Redeem with /shop redeem',
    color: BRAND.gold,
  });
}

async function redemptionButton(i) {
  if (!i.isStaff) throw new UserError('Only staff can handle redemptions.');
  const [, action, id] = i.args;
  const r = shop.resolve(Number(id), action === 'done' ? 'fulfilled' : 'refunded', i.userId);
  await i.update({
    embeds: [ui.embed({ title: `REDEMPTION #${r.id}  |  ${r.status.toUpperCase()}`, description: `${ui.mention(r.user_id)} · **${r.item_name}** (${r.cost} credits)\nHandled by ${ui.mention(i.userId)}`, color: r.status === 'fulfilled' ? BRAND.green : BRAND.grey })],
    components: [],
  });
  await api.dm(r.user_id, { embeds: [ui.info(r.status === 'fulfilled' ? `Your **${r.item_name}** is ready. A coach will reach out.` : `Your **${r.item_name}** redemption was refunded (${r.cost} credits).`, 'CREDIT SHOP')] });
}

async function creditKeyAutocomplete(i) {
  const q = String((i.focused() || {}).value || '').toLowerCase();
  await i.autocomplete(shop.items(true).filter((x) => x.name.toLowerCase().includes(q)).map((x) => ({ name: `#${x.id} ${x.name} (${x.cost})${x.active ? '' : ' [hidden]'}`, value: x.id })));
}

module.exports = {
  commands: [
    {
      def: b.command('credits', 'Your credits, the leaderboard, and how to earn', [
        b.sub('balance', 'Balance and recent history', [b.user('member', 'Whose (default: you)')]),
        b.sub('leaderboard', 'Top earners', [b.str('period', 'Time range', { choices: [{ name: 'This week', value: 'week' }, { name: 'This season', value: 'season' }, { name: 'All time', value: 'all' }] })]),
        b.sub('earn', 'Every way to earn credits'),
      ]),
      run: async (i) => {
        if (i.sub === 'balance') return i.reply({ embeds: [balanceEmbed(i.get('member') || i.userId)], ephemeral: true });
        if (i.sub === 'leaderboard') return i.reply({ embeds: [leaderboardEmbed(i.str('period') || 'season')] });
        return i.reply({ embeds: [earnGuide()], ephemeral: true });
      },
    },
    {
      def: b.command('shop', 'Spend your credits on coaching and perks', [
        b.sub('view', 'See what\'s in the shop'),
        b.sub('redeem', 'Redeem an item', [b.int('item', 'Item', { required: true, autocomplete: true })]),
      ]),
      run: async (i) => {
        if (i.sub === 'view') return i.reply({ embeds: [shopEmbed()], ephemeral: true });
        const { redemption, balance } = shop.redeem(i.userId, i.int('item'));
        await api.post('redemptions', {
          embeds: [ui.embed({ title: `REDEMPTION #${redemption.id}`, description: `${ui.mention(i.userId)} redeemed **${redemption.item_name}** (${redemption.cost} credits).`, color: BRAND.gold, timestamp: true })],
          components: ui.rows([ui.button(`redeem:done:${redemption.id}`, 'Fulfilled', 'success'), ui.button(`redeem:refund:${redemption.id}`, 'Refund', 'secondary')]),
        });
        return i.reply({ embeds: [ui.ok(`Redeemed **${redemption.item_name}**. Staff will reach out to set it up. Balance: ${balance} credits.`)], ephemeral: true });
      },
      autocomplete: creditKeyAutocomplete,
    },
    {
      def: b.command('bank', 'Staff: adjust credits and manage the shop', [
        b.sub('give', 'Give credits', [b.user('member', 'Member', { required: true }), b.int('amount', 'Credits', { required: true, min: 1, max: 100000 }), b.str('reason', 'Reason', { required: true, max: 150 })]),
        b.sub('take', 'Remove credits', [b.user('member', 'Member', { required: true }), b.int('amount', 'Credits', { required: true, min: 1, max: 100000 }), b.str('reason', 'Reason', { required: true, max: 150 })]),
        b.sub('item-add', 'Add a shop item', [b.str('name', 'Item name', { required: true, max: 80 }), b.int('cost', 'Cost in credits', { required: true, min: 1 }),
          b.str('description', 'What they get', { required: true, max: 200 }), b.int('stock', 'How many (blank = unlimited)', { min: 0 })]),
        b.sub('item-edit', 'Change a shop item', [b.int('item', 'Item', { required: true, autocomplete: true }), b.int('cost', 'New cost', { min: 1 }),
          b.str('name', 'New name', { max: 80 }), b.str('description', 'New description', { max: 200 }), b.int('stock', 'New stock (-1 = unlimited)', { min: -1 }), b.bool('active', 'Show in shop')]),
        b.sub('redemptions', 'Open redemptions'),
      ], 'staff'),
      run: async (i) => {
        if (!i.isStaff) throw new UserError('Only staff can do that.');
        switch (i.sub) {
          case 'give':
          case 'take': {
            const amt = i.sub === 'give' ? i.int('amount') : -i.int('amount');
            const r = credits.award(i.get('member'), amt, 'adjust', i.str('reason'), { by: i.userId });
            return i.reply({ embeds: [ui.ok(`${ui.signed(amt)} to ${ui.mention(i.get('member'))}: ${i.str('reason')}. Balance: ${r.balance}.`)], ephemeral: true });
          }
          case 'item-add': {
            const it = shop.add({ name: i.str('name'), cost: i.int('cost'), description: i.str('description'), stock: i.int('stock') ?? -1 });
            return i.reply({ embeds: [ui.ok(`Added **#${it.id} ${it.name}** for ${it.cost} credits.`)], ephemeral: true });
          }
          case 'item-edit': {
            const it = shop.edit(i.int('item'), { cost: i.int('cost'), name: i.str('name'), description: i.str('description'), stock: i.int('stock'), active: i.bool('active') === null ? null : (i.bool('active') ? 1 : 0) });
            return i.reply({ embeds: [ui.ok(`Updated **#${it.id} ${it.name}** · ${it.cost} credits · ${it.active ? 'visible' : 'hidden'}.`)], ephemeral: true });
          }
          case 'redemptions': {
            const open = shop.openRedemptions();
            return i.reply({ embeds: [ui.embed({ title: 'OPEN REDEMPTIONS', description: open.length ? open.map((r) => `#${r.id} ${ui.mention(r.user_id)} · ${r.item_name} · ${ts(r.created_at, 'R')}`).join('\n') : 'Nothing open.', color: BRAND.gold })], ephemeral: true });
          }
          default: throw new UserError('Unknown option.');
        }
      },
      autocomplete: creditKeyAutocomplete,
    },
    {
      def: b.command('strike', 'Staff: strikes', [
        b.sub('add', 'Issue a strike', [b.user('member', 'Member', { required: true }),
          b.str('kind', 'Type', { required: true, choices: Object.entries(strikes.KIND_LABEL).map(([value, name]) => ({ name, value })) }),
          b.str('reason', 'Reason', { required: true, max: 200 })]),
        b.sub('void', 'Void a strike by its number', [b.int('id', 'Strike number', { required: true, min: 1 })]),
        b.sub('list', 'A member\'s strikes this season', [b.user('member', 'Member', { required: true })]),
      ], 'staff'),
      run: async (i) => {
        if (!i.isStaff) throw new UserError('Only staff can do that.');
        if (i.sub === 'add') {
          const r = strikes.add(i.get('member'), i.str('kind'), i.str('reason'), { by: i.userId });
          return i.reply({ embeds: [ui.ok(`Strike #${r.id} issued to ${ui.mention(i.get('member'))}. They have ${r.total} this season.`)], ephemeral: true });
        }
        if (i.sub === 'void') {
          const s = strikes.voidStrike(i.int('id'), i.userId);
          if (!s) throw new UserError('No strike with that number.');
          return i.reply({ embeds: [ui.ok(`Strike #${s.id} voided for ${ui.mention(s.user_id)}.`)], ephemeral: true });
        }
        const list = strikes.list(i.get('member'));
        return i.reply({
          embeds: [ui.embed({
            title: `STRIKES  |  SEASON ${settings.season()}`,
            description: `${ui.mention(i.get('member'))}\n\n${list.length ? list.map((s) => `${s.voided ? '~~' : ''}#${s.id} ${strikes.KIND_LABEL[s.kind] || s.kind}: ${s.reason} · ${ts(s.created_at, 'd')}${s.voided ? '~~ (void)' : ''}`).join('\n') : 'Clean record.'}`,
            color: BRAND.silver,
          })],
          ephemeral: true,
        });
      },
    },
  ],
  buttons: { redeem: redemptionButton },
  balanceEmbed,
  leaderboardEmbed,
};

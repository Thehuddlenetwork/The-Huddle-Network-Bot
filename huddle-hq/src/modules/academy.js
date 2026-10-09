'use strict';
// The Huddle Academy (Standard and Pro members only — roles come from Whop).
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const settings = require('../settings');
const { UserError } = require('../bus');
const academy = require('../services/academy');
const members = require('../services/members');
const { BRAND, ACADEMY_LEVELS } = require('../constants');

function requirePaid(i) {
  if (i.isStaffOr('coach') || i.hasRole('standard') || i.hasRole('pro')) return;
  const url = settings.get('whop_url');
  throw new UserError(`The Huddle Academy is for Standard and Pro members.${url ? ` Join here: ${url}` : ' Ask staff how to upgrade.'}`);
}

function progressEmbed(userId) {
  const done = academy.current(userId);
  const lines = ACADEMY_LEVELS.map((l, n) => {
    const lvl = n + 1;
    const mark = lvl <= done ? '✅' : lvl === done + 1 ? '▶️' : '🔒';
    return `${mark} **L${lvl} ${l.name}**${lvl === done + 1 ? `\n   Check-in: ${l.check}` : ''}`;
  });
  return ui.embed({
    title: `THE HUDDLE ACADEMY  |  ${done}/${ACADEMY_LEVELS.length}`,
    description: `${lines.join('\n')}\n\n${done < ACADEMY_LEVELS.length ? `Finish the work, then \`/academy submit\`. Each level pays +${settings.credit('academyLevel')} credits.` : 'Every level complete.'}`,
    color: BRAND.red,
  });
}

const reviewButtons = (s) => ui.rows([ui.button(`acad:approve:${s.id}`, 'Approve level', 'success'), ui.button(`acad:back:${s.id}`, 'Needs work', 'secondary')]);

async function reviewButton(i) {
  if (!i.isStaffOr('coach')) throw new UserError('Only coaches review Academy check-ins.');
  const [, action, id] = i.args;
  if (action === 'back') {
    return i.showModal(ui.modal(`acad:backm:${id}`, 'NEEDS WORK', [{ id: 'fb', label: 'What to fix (sent to the member)', paragraph: true, max: 500 }]));
  }
  const r = academy.approve(Number(id), i.userId);
  const roleId = settings.get(`academy_role:${r.level}`);
  if (roleId) await api.addRole(r.submission.user_id, roleId, `Academy L${r.level}`);
  await i.update({
    embeds: [ui.embed({ title: `CHECK-IN #${id}  |  APPROVED`, description: `${ui.mention(r.submission.user_id)} completed **${academy.levelName(r.level)}**. +${r.paid} credits.\nApproved by ${ui.mention(i.userId)}`, color: BRAND.green })],
    components: [],
  });
  const next = ACADEMY_LEVELS[r.level];
  await api.dm(r.submission.user_id, {
    embeds: [ui.ok(`**${academy.levelName(r.level)}** complete. +${r.paid} credits.${next ? `\n\nNext up: **L${r.level + 1} ${next.name}**\n${next.check}` : '\n\nThat\'s every level. You finished the Academy.'}`, 'LEVEL UP')],
  });
}

async function backModal(i) {
  if (!i.isStaffOr('coach')) throw new UserError('Only coaches review Academy check-ins.');
  const s = academy.sendBack(Number(i.args[2]), i.userId, i.field('fb'));
  await i.reply({ embeds: [ui.ok('Feedback sent.')], ephemeral: true });
  if (s.channel_id && s.message_id) {
    await api.safeEdit(s.channel_id, s.message_id, {
      embeds: [ui.embed({ title: `CHECK-IN #${s.id}  |  NEEDS WORK`, description: `${ui.mention(s.user_id)} · ${academy.levelName(s.level)}\nCoach notes: ${s.feedback}`, color: BRAND.grey })],
      components: [],
    });
  }
  await api.dm(s.user_id, { embeds: [ui.info(`Your **${academy.levelName(s.level)}** check-in needs a little more:\n\n${s.feedback}\n\nFix it up and \`/academy submit\` again.`, 'COACH NOTES')] });
}

module.exports = {
  commands: [
    {
      def: b.command('academy', 'The Huddle Academy', [
        b.sub('progress', 'Your levels and what\'s next'),
        b.sub('submit', 'Submit your check-in for the next level'),
        b.sub('setrole', 'Staff: role to give when a level is completed', [
          b.int('level', 'Level', { required: true, min: 1, max: ACADEMY_LEVELS.length }), b.role('role', 'Role (leave empty to clear)'),
        ]),
      ]),
      run: async (i) => {
        if (i.sub === 'setrole') {
          if (!i.isStaff) throw new UserError('Only staff can do that.');
          settings.set(`academy_role:${i.int('level')}`, i.get('role'));
          return i.reply({ embeds: [ui.ok(i.get('role') ? `Level ${i.int('level')} now gives <@&${i.get('role')}>.` : `Level ${i.int('level')} role cleared.`)], ephemeral: true });
        }
        requirePaid(i);
        if (i.sub === 'progress') return i.reply({ embeds: [progressEmbed(i.userId)], ephemeral: true });
        const lvl = academy.current(i.userId) + 1;
        if (lvl > ACADEMY_LEVELS.length) throw new UserError('You\'ve completed every level.');
        return i.showModal(ui.modal('acad:submitm', `L${lvl} ${ACADEMY_LEVELS[lvl - 1].name}`.slice(0, 45), [
          { id: 'proof', label: 'Proof: links or a description', paragraph: true, placeholder: ACADEMY_LEVELS[lvl - 1].check, max: 1000 },
          { id: 'notes', label: 'Anything you want your coach to know', paragraph: true, required: false, max: 500 },
        ]));
      },
    },
  ],
  buttons: { acad: reviewButton },
  modals: {
    'acad:submitm': async (i) => {
      requirePaid(i);
      const s = academy.submit(i.userId, { proof: i.field('proof'), notes: i.field('notes') });
      await i.defer(true);
      const m = members.get(i.userId);
      const coach = settings.roleId('coach');
      const msg = await api.post('academy', {
        content: coach ? `<@&${coach}>` : undefined,
        allowed_mentions: { parse: ['roles'] },
        embeds: [ui.embed({
          title: `CHECK-IN #${s.id}  |  ${academy.levelName(s.level).toUpperCase()}`,
          description: `${ui.mention(i.userId)}${m && m.streamer_name ? ` (${m.streamer_name})` : ''}\n\n**Proof**\n${s.proof}${s.notes ? `\n\n**Notes**\n${s.notes}` : ''}`,
          color: BRAND.gold, timestamp: true,
        })],
        components: reviewButtons(s),
      });
      if (msg) academy.setMessage(s.id, msg.channel_id, msg.id);
      await i.send({ embeds: [ui.ok(`Level ${s.level} check-in sent to the coaches.`)] });
    },
    'acad:backm': backModal,
  },
};

'use strict';
// The Highlight Reel and Clip of the Week.
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const settings = require('../settings');
const { UserError } = require('../bus');
const clips = require('../services/clips');
const members = require('../services/members');
const games = require('../services/games');
const { ts, at, weekday } = require('../lib/time');
const { BRAND, CLIP_TYPES } = require('../constants');

function clipEmbed(c, { review = false } = {}) {
  const m = members.get(c.user_id);
  const g = c.game_id ? games.getGame(c.game_id) : null;
  return ui.embed({
    title: `CLIP #${c.id}  |  ${c.type.toUpperCase()}`,
    url: c.url,
    description: [
      `${ui.mention(c.user_id)}${m && m.team ? ` · ${m.team}` : ''}`,
      c.url,
      g ? `From: ${games.fullLabel(g)}` : null,
      c.vertical ? '📱 Vertical with captions' : null,
      c.note ? `> ${ui.clip(c.note, 200)}` : null,
      review ? `\nStatus: **${c.status}**${c.featured ? ' · featured' : ''}${c.milestones ? ` · ${c.milestones.replace(/,$/, '').toUpperCase()} views` : ''}` : null,
    ].filter(Boolean).join('\n'),
    color: c.status === 'declined' ? BRAND.grey : c.featured ? BRAND.gold : BRAND.red,
  });
}

const reviewButtons = (c) => (c.status === 'pending'
  ? ui.rows([ui.button(`clip:accept:${c.id}`, 'Accept', 'success'), ui.button(`clip:feature:${c.id}`, 'Accept + Feature', 'primary'), ui.button(`clip:decline:${c.id}`, 'Decline', 'danger')])
  : c.status === 'accepted' ? ui.rows([ui.button(`clip:feature:${c.id}`, 'Featured on socials', 'primary')]) : []);

async function reviewButton(i) {
  if (!i.isStaffOr('clipTeam')) throw new UserError('Only the clip team reviews clips.');
  const [, action, id] = i.args;
  const clipId = Number(id);
  let note = '';
  if (action === 'accept') {
    const r = clips.accept(clipId, i.userId);
    note = r.capped ? 'Accepted. Weekly credit cap reached, so no credits.' : `Accepted. +${r.paid} credits.`;
    await api.dm(r.clip.user_id, { embeds: [ui.ok(`Your clip #${clipId} was accepted${r.paid ? `: +${r.paid} credits` : ''}.`, 'HIGHLIGHT REEL')] });
  } else if (action === 'feature') {
    const r = clips.feature(clipId, i.userId);
    note = `Featured. +${r.paid} credits.`;
    await api.dm(r.clip.user_id, { embeds: [ui.ok(`Your clip #${clipId} is going up on THN socials: +${r.paid} credits. Share the post when it lands.`, 'FEATURED')] });
  } else if (action === 'decline') {
    clips.decline(clipId, i.userId);
    note = 'Declined.';
  }
  const c = clips.get(clipId);
  await i.update({ embeds: [clipEmbed(c, { review: true }), ui.info(`${note} (${ui.mention(i.userId)})`)], components: reviewButtons(c) });
}

function nextSundayClose(now = Date.now()) {
  const wd = weekday(now);
  let close = at(now, (7 - wd) % 7, 18, 0);
  if (close <= now) close = at(now, 7, 18, 0);
  return close;
}

function pollPayload(p, counts = {}) {
  const lines = p.clips.map((c, n) => {
    const m = members.get(c.user_id);
    return `**${n + 1}. ${(m && m.streamer_name) || 'Member'}** · ${c.type} · ${counts[c.id] || 0} vote${counts[c.id] === 1 ? '' : 's'}\n${c.url}`;
  });
  return {
    embeds: [ui.embed({
      title: p.status === 'open' ? '🎬 CLIP OF THE WEEK  |  VOTE NOW' : '🎬 CLIP OF THE WEEK  |  FINAL',
      description: `${lines.join('\n\n')}\n\n${p.status === 'open' ? `Voting closes ${ts(p.closes_at, 'R')}. One vote each, and you can change it.` : 'Voting closed.'}`,
      color: BRAND.red,
    })],
    components: p.status === 'open' ? ui.rows(p.clips.map((c, n) => ui.button(`cotw:vote:${p.id}:${c.id}`, `Vote ${n + 1}`, 'primary'))) : [],
  };
}

async function openVote(clipIds) {
  const p = clips.openPoll(clipIds, nextSundayClose());
  const msg = await api.post('clipVote', pollPayload(p));
  if (msg) clips.setPollMessage(p.id, msg.channel_id, msg.id);
  return p;
}

async function closeVote(pollId) {
  const r = clips.closePoll(pollId);
  const p = clips.getPoll(pollId);
  if (p.channel_id && p.message_id) await api.safeEdit(p.channel_id, p.message_id, pollPayload(p, r.counts));
  const hl = settings.roleId('highlight');
  if (hl) {
    const prev = settings.get('highlight_holder');
    if (prev && prev !== r.winner.user_id) await api.removeRole(prev, hl, 'Clip of the Week passed on');
    await api.addRole(r.winner.user_id, hl, 'Clip of the Week');
    settings.set('highlight_holder', r.winner.user_id);
  }
  const m = members.get(r.winner.user_id);
  await api.post('wire', {
    embeds: [ui.embed({ title: '🏆 CLIP OF THE WEEK', description: `**${(m && m.streamer_name) || 'THN Member'}** (${ui.mention(r.winner.user_id)}) takes it with ${r.votes} vote${r.votes === 1 ? '' : 's'}.\n${r.winner.url}\n+${r.paid} credits and the Highlight role.`, color: BRAND.gold })],
  });
  return r;
}

module.exports = {
  commands: [
    {
      def: b.command('clip', 'The Highlight Reel', [
        b.sub('submit', 'Send a clip from a THN game (under 60 sec, within 48 hrs)', [
          b.str('link', 'Clip link', { required: true, max: 300 }),
          b.str('type', 'What kind of moment', { required: true, choices: CLIP_TYPES.map((t) => ({ name: t, value: t })) }),
          b.bool('vertical', 'Already cut vertical with captions?'),
          b.str('note', 'Context for the clip team', { max: 200 }),
        ]),
        b.sub('mine', 'Your recent clips'),
      ]),
      run: async (i) => {
        if (i.sub === 'mine') {
          const list = clips.byUser(i.userId);
          return i.reply({ embeds: [ui.embed({ title: 'YOUR CLIPS', description: list.length ? list.map((c) => `#${c.id} ${c.type} · **${c.status}**${c.featured ? ' ⭐' : ''} · ${ts(c.created_at, 'R')}`).join('\n') : 'No clips yet. `/clip submit` your best moment.', color: BRAND.black })], ephemeral: true });
        }
        const m = members.get(i.userId);
        if (!m || m.status !== 'active') throw new UserError('Clips are for approved THN members.');
        const c = clips.submit(i.userId, { url: i.str('link'), type: i.str('type'), vertical: !!i.bool('vertical'), note: i.str('note') });
        await i.defer(true);
        const msg = await api.post('clipReview', { embeds: [clipEmbed(c)], components: reviewButtons(c) });
        if (msg) clips.setMessage(c.id, msg.channel_id, msg.id);
        return i.send({ embeds: [ui.ok(`Clip #${c.id} is in the review queue. Accepted clips earn +${settings.credit('clipAccepted')}${c.vertical ? ` (+${settings.credit('clipVertical')} vertical bonus)` : ''}, and featured clips earn +${settings.credit('clipFeatured')}.`)] });
      },
    },
  ],
  buttons: {
    clip: reviewButton,
    cotw: async (i) => {
      const [, , pollId, clipId] = i.args;
      const counts = clips.votePoll(Number(pollId), i.userId, Number(clipId));
      await i.reply({ embeds: [ui.ok('Vote counted.')], ephemeral: true });
      const p = clips.getPoll(Number(pollId));
      if (p.channel_id && p.message_id) await api.safeEdit(p.channel_id, p.message_id, pollPayload(p, counts));
    },
  },
  openVote,
  closeVote,
  clipEmbed,
};

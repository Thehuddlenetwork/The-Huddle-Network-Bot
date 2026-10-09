'use strict';
// Joining, applications, team assignment, availability, profiles and help.
const settings = require('../settings');
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const { UserError } = require('../bus');
const members = require('../services/members');
const games = require('../services/games');
const credits = require('../services/credits');
const strikes = require('../services/strikes');
const score = require('../services/score');
const academy = require('../services/academy');
const availability = require('../services/availability');
const { TEAMS } = require('../lib/teams');
const { BRAND, LEAGUES, WINDOWS, WEEKDAYS, TIMEZONES } = require('../constants');

// ---------- join ----------

function joinModal(existing) {
  return ui.modal('join:submit', 'JOIN THE HUDDLE NETWORK', [
    { id: 'name', label: 'Streamer name', placeholder: 'What your viewers call you', value: existing && existing.streamer_name, max: 40 },
    { id: 'url', label: 'Main stream link', placeholder: 'twitch.tv/yourname, YouTube or TikTok link', value: existing && existing.stream_url, max: 200 },
    { id: 'tag', label: 'Gamertag and console', placeholder: 'JD_Madden / PS5', value: existing && existing.gamertag, max: 60 },
    { id: 'tz', label: 'Your time zone', placeholder: 'PT, MT, CT or ET', value: existing && existing.timezone, max: 30 },
    { id: 'avail', label: 'When can you usually play?', placeholder: 'Weeknights after 7 PM, weekends anytime', value: existing && existing.availability_note, paragraph: true, max: 300 },
  ]);
}

function availabilityComponents(m) {
  const days = new Set(m && m.avail_days ? m.avail_days.split(',').map(Number) : []);
  const wins = new Set(m && m.avail_windows ? m.avail_windows.split(',') : []);
  return [
    ui.select('avail:tz', Object.entries(TIMEZONES).map(([k, v]) => ({ label: v.label, value: k, default: (m && m.timezone) === k })), { placeholder: 'Your time zone' }),
    ui.select('avail:days', WEEKDAYS.map((d, i) => ({ label: d, value: String(i + 1), default: days.has(i + 1) })), { placeholder: 'Days you can play', min: 1, max: 7 }),
    ui.select('avail:windows', Object.entries(WINDOWS).map(([k, v]) => ({ label: v.label, value: k, default: wins.has(k) })), { placeholder: 'Times you can play', min: 1, max: 5 }),
  ];
}

function availabilityEmbed(m) {
  const d = availability.describe(m);
  return ui.embed({
    title: 'YOUR AVAILABILITY',
    description: [
      'The Game Scheduler uses this to suggest kickoff times you and your opponent can both make. Changes save as you pick.',
      '',
      `**Time zone:** ${TIMEZONES[d.tz] ? TIMEZONES[d.tz].label : d.tz}`,
      `**Days:** ${d.isSet ? d.days : 'Not set (using every day)'}`,
      `**Times:** ${d.isSet ? d.windows : 'Not set (using 5 to 11 PM)'}`,
    ].join('\n'),
    color: BRAND.black,
  });
}

function applicationEmbed(m, userId) {
  return ui.embed({
    title: `APPLICATION  |  ${(m.streamer_name || 'New streamer').toUpperCase()}`,
    description: `${ui.mention(userId)}`,
    fields: [
      { name: 'Stream', value: m.stream_url, inline: false },
      { name: 'Gamertag', value: m.gamertag, inline: true },
      { name: 'Time zone', value: m.timezone, inline: true },
      { name: 'Availability', value: m.availability_note },
    ],
    color: BRAND.gold, timestamp: true,
  });
}

async function startJoin(i) {
  const m = members.get(i.userId);
  if (m && m.status === 'active') {
    return i.showModal({ ...joinModal(m), title: 'UPDATE YOUR THN PROFILE' });
  }
  return i.showModal(joinModal(m));
}

async function submitJoin(i) {
  const before = members.get(i.userId);
  const wasActive = before && before.status === 'active';
  const { member, tzGuessed } = members.saveApplication(i.userId, {
    streamerName: i.field('name'), streamUrl: i.field('url'), gamertag: i.field('tag'), timezone: i.field('tz'), availability: i.field('avail'),
  });
  if (!wasActive) {
    await api.post('applications', {
      embeds: [applicationEmbed(member, i.userId)],
      components: ui.rows([
        ui.button(`app:approve:${i.userId}`, 'Approve', 'success'),
        ui.button(`app:waitlist:${i.userId}`, 'Waitlist', 'secondary'),
        ui.button(`app:decline:${i.userId}`, 'Decline', 'danger'),
      ]),
    });
  }
  const msg = wasActive
    ? 'Profile updated.'
    : `Application received, ${member.streamer_name}. Staff will review it soon.${tzGuessed ? ' I couldn\'t read your time zone, so it\'s set to PT for now.' : ''}`;
  await i.reply({
    embeds: [ui.ok(`${msg}\n\nSet your availability below so the Game Scheduler can find kickoff times that work for you.`, wasActive ? 'UPDATED' : 'WELCOME TO THE HUDDLE'), availabilityEmbed(member)],
    components: availabilityComponents(member),
    ephemeral: true,
  });
}

function teamOptions(league, conf) {
  return TEAMS.filter((t) => t.conf === conf && !members.byTeam(league, t.name))
    .map((t) => ({ label: `${t.city} ${t.name}`, value: t.name, description: t.div }));
}

async function decideApplication(i) {
  if (!i.isStaff) throw new UserError('Only staff can review applications.');
  const [, action, userId] = i.args;
  const m = members.get(userId);
  if (!m) throw new UserError('That application no longer exists.');
  let resultText;
  if (action === 'approve') {
    const approved = members.approve(userId, settings.activeLeagues()[0] || 'HL');
    await api.addRoleFor(userId, 'member', 'Approved THN member');
    await api.addRoleFor(userId, approved.league === 'NL' ? 'leagueNL' : 'leagueHL', 'League placement');
    await api.removeRoleFor(userId, 'waitlist', 'Approved');
    await api.dm(userId, { embeds: [ui.ok('You\'re in. Welcome to **The Huddle Network**. Your team assignment is next, and your game threads will appear in the game-times channel after each advance.', 'APPROVED')] });
    resultText = `✅ Approved by ${ui.mention(i.userId)}`;
  } else if (action === 'waitlist') {
    members.setStatus(userId, 'waitlist');
    await api.addRoleFor(userId, 'waitlist', 'Waitlisted');
    await api.dm(userId, { embeds: [ui.info('Thanks for applying to The Huddle Network. You\'re on the waitlist, and we\'ll reach out as soon as a team opens up.', 'WAITLIST')] });
    resultText = `🕒 Waitlisted by ${ui.mention(i.userId)}`;
  } else {
    members.setStatus(userId, 'declined');
    resultText = `❌ Declined by ${ui.mention(i.userId)}`;
  }
  const embed = applicationEmbed(members.get(userId), userId);
  embed.fields = [...(embed.fields || []), { name: 'Decision', value: resultText }];
  await i.update({ embeds: [embed], components: [] });
  if (action === 'approve') {
    const league = members.get(userId).league || 'HL';
    await i.followUp({
      content: `Assign ${ui.mention(userId)} a ${LEAGUES[league]} team:`,
      components: [
        ui.select(`teamsel:${userId}:${league}:AFC`, teamOptions(league, 'AFC'), { placeholder: 'Open AFC teams' }),
        ui.select(`teamsel:${userId}:${league}:NFC`, teamOptions(league, 'NFC'), { placeholder: 'Open NFC teams' }),
      ].filter((r) => r.components[0].options.length),
      ephemeral: true,
    });
  }
}

async function pickTeam(i) {
  if (!i.isStaff) throw new UserError('Only staff can assign teams.');
  const [, userId, league] = i.args;
  const { team } = members.assignTeam(userId, league, i.values[0]);
  await api.addRoleFor(userId, 'member', 'Team assigned');
  await api.addRoleFor(userId, league === 'NL' ? 'leagueNL' : 'leagueHL', 'Team assigned');
  games.refreshWeekOwners(league, settings.week(league));
  await i.update({ content: `✅ ${ui.mention(userId)} now owns the **${team.city} ${team.name}** (${LEAGUES[league]}).`, components: [] });
  await api.dm(userId, { embeds: [ui.ok(`You're the owner of the **${team.city} ${team.name}** in the ${LEAGUES[league]}.`, 'TEAM ASSIGNED')] });
}

// ---------- availability ----------

async function availabilitySelect(i) {
  const key = i.args[1];
  if (key === 'tz') members.setAvailability(i.userId, { timezone: i.values[0] });
  if (key === 'days') members.setAvailability(i.userId, { days: i.values.map(Number).sort() });
  if (key === 'windows') members.setAvailability(i.userId, { windows: i.values });
  const m = members.get(i.userId);
  await i.update({ embeds: [availabilityEmbed(m)], components: availabilityComponents(m) });
}

// ---------- profile ----------

function profileEmbed(userId, roleIds) {
  const m = members.get(userId);
  if (!m) throw new UserError('That person hasn\'t joined THN yet.');
  const sc = score.compute(userId);
  const st = sc.stats;
  const rec = `${st.record.w}-${st.record.l}${st.record.t ? `-${st.record.t}` : ''}`;
  const tier = roleIds ? members.tierFromRoles(roleIds, settings) : null;
  const catLines = Object.values(sc.categories).map((c) => `\`${c.label.padEnd(12)}\` ${ui.bar(c.value)} **${c.value}**`);
  return ui.embed({
    title: `${(m.streamer_name || 'THN MEMBER').toUpperCase()}  |  ${sc.ovr} OVR CREATOR`,
    url: m.stream_url || undefined,
    description: [
      m.team ? `**${m.team}** · ${LEAGUES[m.league] || ''} · ${rec}` : `${LEAGUES[m.league] || 'No league yet'} · no team assigned`,
      tier ? `Membership: **${tier}**` : null,
      '',
      ...catLines,
    ].filter((x) => x !== null).join('\n'),
    fields: [
      { name: 'Credits', value: `${credits.balance(userId)}`, inline: true },
      { name: 'On time', value: ui.pctText(st.ontime, st.timed), inline: true },
      { name: 'Completed', value: ui.pctText(st.complete, st.counted), inline: true },
      { name: 'Streaks', value: `On time: ${m.ontime_streak || 0} (best ${m.best_ontime_streak || 0})\nComplete: ${m.complete_streak || 0}`, inline: true },
      { name: 'Strikes', value: `${sc.strikes}${strikes.isFrozen(userId) ? ' · trades frozen' : ''}`, inline: true },
      { name: 'Academy', value: academy.levelName(m.academy_level || 0), inline: true },
    ],
    color: BRAND.red,
  });
}

// ---------- help ----------

function helpEmbed(staff) {
  const memberLines = [
    '**Getting set up**',
    '`/join` apply or update your profile · `/availability` days and times you can play',
    '**Game day**',
    '`/game time` lock a kickoff · `/game suggest` times that work for both of you',
    '`/golive` check in live (TikTok or anything the bot can\'t see) · `/game kickoff` · `/game final`',
    'Or use the buttons on your game post. They do the same thing.',
    '**Your stuff**',
    '`/profile` your Creator card · `/credits` balance and history · `/shop` spend credits',
    '`/tradedesk propose` · `/clip submit` · `/academy` (Standard and Pro)',
    '**Network**',
    '`/matchups` this week · `/tonight` today\'s games · `/score leaderboard` · `/draftrace`',
    '`/stands scout|raid|chat` support other members · `/passport` viewer stamps · `/awards vote`',
  ];
  const staffLines = [
    '',
    '**Staff**',
    '`/setup` server wiring · `/commish` teams, schedule, advances, seasons',
    '`/ruling` force-wins, sims, no-shows, rage quits, verify live · `/strike` · `/bank` credits and shop',
    '`/hq` dashboard, Game of the Week, clips, events, awards, Creator Score ratings, backups',
  ];
  return ui.embed({ title: 'HUDDLE HQ  |  COMMANDS', description: [...memberLines, ...(staff ? staffLines : [])].join('\n'), color: BRAND.black });
}

module.exports = {
  commands: [
    {
      def: b.command('join', 'Apply to The Huddle Network, or update your profile'),
      run: startJoin,
    },
    {
      def: b.command('availability', 'Set the days and times you can play (used by the Game Scheduler)'),
      run: async (i) => {
        const m = members.get(i.userId) || members.setAvailability(i.userId, {});
        await i.reply({ embeds: [availabilityEmbed(m)], components: availabilityComponents(m), ephemeral: true });
      },
    },
    {
      def: b.command('profile', 'Creator profile: OVR, record, credits, reliability', [b.user('member', 'Whose profile (default: you)')]),
      run: async (i) => {
        const target = i.get('member') || i.userId;
        const roles = target === i.userId ? i.roles : (i.resolved.members && i.resolved.members[target] ? i.resolved.members[target].roles : null);
        await i.reply({ embeds: [profileEmbed(target, roles)] });
      },
    },
    {
      def: b.command('stream', 'Update the stream link the bot uses for you', [b.str('link', 'Your main stream link', { required: true, max: 200 })]),
      run: async (i) => {
        const m = members.updateStream(i.userId, i.str('link'));
        await i.reply({ embeds: [ui.ok(`Stream link saved: ${m.stream_url}${m.twitch_login ? '\nTwitch go-live detection is on for this channel.' : ''}`)], ephemeral: true });
      },
    },
    {
      def: b.command('help', 'How to use Huddle HQ'),
      run: (i) => i.reply({ embeds: [helpEmbed(i.isStaff)], ephemeral: true }),
    },
  ],
  buttons: {
    'join:open': startJoin,
    app: decideApplication,
  },
  selects: {
    avail: availabilitySelect,
    teamsel: pickTeam,
  },
  modals: {
    'join:submit': submitJoin,
  },
  profileEmbed,
  availabilityComponents,
  availabilityEmbed,
};

'use strict';
// League operations: teams, schedule import, advances, seasons, Nothing To Lose.
const db = require('../db');
const settings = require('../settings');
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const { UserError } = require('../bus');
const games = require('../services/games');
const members = require('../services/members');
const league = require('../services/league');
const score = require('../services/score');
const gameView = require('../views/game');
const scheduleView = require('../views/schedule');
const { rulingButtons } = require('./games');
const { TEAMS } = require('../lib/teams');
const { ts, resolveGameTime, HOUR } = require('../lib/time');
const { BRAND, LEAGUES } = require('../constants');

function requireStaff(i) {
  if (!i.isStaff) throw new UserError('Only staff can do that.');
}

// Shared by /league advance and nothing else: closes the week, posts the new one, flags unplayed games.
async function runAdvance({ leagues, toWeek = null, by = null }) {
  const results = league.advance({ leagues, toWeek });
  const next = games.nextAdvance();
  const embeds = [];
  for (const r of results) {
    for (const g of games.weekGames(r.league, r.from)) await gameView.refresh(g.id);
    const posted = await gameView.postWeek(r.league, r.to);
    for (const u of r.unplayed) {
      const sug = u.suggestion.type === 'forcewin'
        ? `Suggested: force win to **${u.game[`${u.suggestion.side}_team`]}** (only they checked in live).`
        : 'Suggested: sim, or double loss if neither showed.';
      await api.post('staffAlerts', {
        embeds: [ui.embed({ title: 'UNPLAYED AT ADVANCE', description: `${games.fullLabel(u.game)}\n${ui.mention(u.away.user_id)} vs ${ui.mention(u.home.user_id)}\n${sug}${u.game.thread_id ? `\nThread: <#${u.game.thread_id}>` : ''}`, color: BRAND.gold })],
        components: rulingButtons(u),
      });
    }
    const humanGames = r.games.filter((g) => g.status !== 'cpu').length;
    const deadline = settings.getInt(`advanced_at:${r.league}`) + settings.limit('lockInHours') * HOUR;
    const lines = [
      humanGames ? `Week ${r.to} game threads are up${settings.channelId(r.league === 'NL' ? 'gamesNL' : 'gamesHL') ? ` in <#${settings.channelId(r.league === 'NL' ? 'gamesNL' : 'gamesHL')}>` : ''}. Lock your game time by ${ts(deadline, 't')} for Lock In credits.` : `Week ${r.to} matchups haven't been imported yet.`,
    ];
    if (r.bonuses.length) {
      for (const bn of r.bonuses) {
        const what = [bn.allOnTime && `Clean Division +${settings.credit('cleanDivision')}`, bn.allComplete && `Clean Advance +${settings.credit('cleanAdvance')}`].filter(Boolean).join(' and ');
        lines.push(`🏅 **${bn.div}**: ${what} for every owner.`);
      }
    }
    if (r.unplayed.length) lines.push(`${r.unplayed.length} unplayed game${r.unplayed.length === 1 ? '' : 's'} sent to staff for rulings.`);
    embeds.push(ui.embed({ title: `⏩ ADVANCED  |  ${LEAGUES[r.league].toUpperCase()} WEEK ${r.to}`, description: lines.join('\n'), color: BRAND.red }));
    if (!humanGames) await api.post('staffAlerts', { embeds: [ui.info(`${LEAGUES[r.league]} week ${r.to} has no matchups. Run \`/commish schedule-import\` and the game threads post automatically.`)] });
    r.posted = posted;
  }
  if (embeds.length) {
    embeds[embeds.length - 1].description += `\n\n**Next advance:** ${ts(next, 'F')} (${ts(next, 'R')})`;
    await api.post('advance', { embeds });
  }
  return results;
}

function teamsEmbed(lg) {
  const fields = ['AFC', 'NFC'].map((conf) => ({
    name: conf,
    value: TEAMS.filter((t) => t.conf === conf).map((t) => {
      const m = members.byTeam(lg, t.name);
      return `${t.abbr.padEnd(3)} ${m ? ui.mention(m.user_id) : '· open'}`;
    }).join('\n'),
    inline: true,
  }));
  const taken = TEAMS.filter((t) => members.byTeam(lg, t.name)).length;
  return ui.embed({ title: `${LEAGUES[lg].toUpperCase()}  |  TEAMS`, fields, footer: `${taken}/32 teams assigned`, color: BRAND.black });
}

async function syncLeagueRoles(userId, lg) {
  await api.addRoleFor(userId, lg === 'NL' ? 'leagueNL' : 'leagueHL', 'League move');
  await api.removeRoleFor(userId, lg === 'NL' ? 'leagueHL' : 'leagueNL', 'League move');
}

async function leagueCommand(i) {
  requireStaff(i);
  const lg = i.str('league') || 'HL';
  switch (i.sub) {
    case 'team-assign': {
      const userId = i.get('member');
      const { team } = members.assignTeam(userId, lg, i.str('team'));
      await api.addRoleFor(userId, 'member', 'Team assigned');
      await syncLeagueRoles(userId, lg);
      games.refreshWeekOwners(lg, settings.week(lg));
      for (const g of games.weekGames(lg, settings.week(lg))) if (g.away_team === team.name || g.home_team === team.name) { await gameView.post(g.id); await gameView.refresh(g.id); }
      return i.reply({ embeds: [ui.ok(`${ui.mention(userId)} owns the **${team.city} ${team.name}** (${LEAGUES[lg]}).`)] });
    }
    case 'team-remove': {
      const m = members.unassign(i.get('member'));
      if (m) games.refreshWeekOwners(m.league || 'HL', settings.week(m.league || 'HL'));
      return i.reply({ embeds: [ui.ok(`${ui.mention(i.get('member'))} no longer has a team.`)], ephemeral: true });
    }
    case 'teams': return i.reply({ embeds: [teamsEmbed(lg)], ephemeral: true });
    case 'move': {
      members.moveLeague(i.get('member'), lg);
      await syncLeagueRoles(i.get('member'), lg);
      return i.reply({ embeds: [ui.ok(`${ui.mention(i.get('member'))} moved to the ${LEAGUES[lg]}. Assign their new team with \`/commish team-assign\`.`)], ephemeral: true });
    }
    case 'remove-member': {
      const userId = i.get('member');
      members.setStatus(userId, i.bool('alumni') ? 'alumni' : 'removed');
      for (const p of ['member', 'leagueHL', 'leagueNL']) await api.removeRoleFor(userId, p, 'Removed from league');
      return i.reply({ embeds: [ui.ok(`${ui.mention(userId)} removed from the league${i.bool('alumni') ? ' (alumni, can return)' : ''}. Their team is open.`)], ephemeral: true });
    }
    case 'schedule-import': {
      const week = i.int('week');
      return i.showModal(ui.modal(`league:schedm:${lg}:${week}`, `${lg} WEEK ${week} MATCHUPS`, [
        { id: 'lines', label: 'One game per line: Away @ Home', paragraph: true, placeholder: 'Raiders @ Chiefs\nBills @ Dolphins\n49ers @ Rams', max: 4000 },
      ]));
    }
    case 'schedule-clear': {
      const gone = games.clearWeek(lg, i.int('week'));
      for (const g of gone) if (g.channel_id && g.message_id) await api.rest().request('DELETE', `/channels/${g.channel_id}/messages/${g.message_id}`).catch(() => {});
      return i.reply({ embeds: [ui.ok(`Cleared ${gone.length} unplayed game(s) from ${LEAGUES[lg]} week ${i.int('week')}.`)], ephemeral: true });
    }
    case 'repost': {
      await i.defer(true);
      const week = i.int('week') ?? settings.week(lg);
      games.refreshWeekOwners(lg, week);
      const n = await gameView.postWeek(lg, week);
      for (const g of games.weekGames(lg, week)) await gameView.refresh(g.id);
      return i.send({ embeds: [ui.ok(`Posted ${n} missing game thread(s) and refreshed week ${week}.`)] });
    }
    case 'advance': {
      await i.defer(true);
      const which = i.str('which') || 'all';
      const leagues = which === 'all' ? league.leaguesInUse() : [which];
      const results = await runAdvance({ leagues, toWeek: i.int('week'), by: i.userId });
      return i.send({ embeds: [ui.ok(results.map((r) => `${LEAGUES[r.league]}: week ${r.from} → ${r.to} · ${r.posted} game threads posted · ${r.unplayed.length} unplayed`).join('\n'), 'ADVANCED')] });
    }
    case 'advance-delay': {
      const next = league.delayAdvance();
      await api.post('advance', { embeds: [ui.embed({ title: '⏩ ADVANCE MOVED', description: `The advance moved to **${ts(next, 'F')}** (${ts(next, 'R')}). Use the extra day to finish your games.`, color: BRAND.gold })] });
      return i.reply({ embeds: [ui.ok(`Next advance: ${ts(next, 'F')}.`)], ephemeral: true });
    }
    case 'advance-set': {
      const r = resolveGameTime(i.str('day'), i.str('time'), 'PT');
      if (r.error) throw new UserError(r.error);
      league.setNextAdvance(r.ms);
      await api.post('advance', { embeds: [ui.embed({ title: '⏩ NEXT ADVANCE', description: `${ts(r.ms, 'F')} (${ts(r.ms, 'R')})`, color: BRAND.gold })] });
      return i.reply({ embeds: [ui.ok(`Next advance set: ${ts(r.ms, 'F')}.`)], ephemeral: true });
    }
    case 'activate': {
      const set = new Set(settings.activeLeagues());
      if (i.bool('on') === false) set.delete(lg); else set.add(lg);
      if (!set.size) set.add('HL');
      settings.set('leagues', [...set].sort().join(','));
      return i.reply({ embeds: [ui.ok(`Active leagues: ${[...set].map((x) => LEAGUES[x]).join(', ')}`)], ephemeral: true });
    }
    case 'season-start': {
      const n = i.int('number');
      const r = league.startSeason(n);
      await api.post('advance', { embeds: [ui.embed({ title: `🏈 SEASON ${n} IS HERE`, description: 'Weeks reset, Audibles reset, streaks reset. Import week 1 with `/commish schedule-import` and advance into it.', color: BRAND.red })] });
      return i.reply({ embeds: [ui.ok(`Season ${n} started.${r.payouts.length ? ` Paid unused Audibles to ${r.payouts.length} member(s).` : ''}`)], ephemeral: true });
    }
    case 'champions': {
      league.setChampions(lg, i.get('champion'), i.get('runner_up'));
      return i.reply({ embeds: [ui.ok(`${LEAGUES[lg]} Season ${settings.season()}: champion ${ui.mention(i.get('champion'))}, runner-up ${ui.mention(i.get('runner_up'))}.`)], ephemeral: true });
    }
    case 'season-review': {
      const rv = league.seasonReview(score.compute);
      const up = rv.up.map((u) => `⬆️ ${ui.mention(u.userId)} · ${u.why}`).join('\n') || 'None yet. Set champions with `/commish champions`.';
      const down = rv.down.map((d) => `⬇️ ${ui.mention(d.userId)} · ${d.why}`).join('\n') || (rv.networkLeagueSize ? 'None' : 'Network League has no members yet.');
      return i.reply({
        embeds: [ui.embed({ title: `SEASON ${rv.season} PROMOTION / RELEGATION`, fields: [{ name: 'Up to the Network League', value: up }, { name: 'Down to the Huddle League', value: down }], footer: 'Apply with /league season-apply', color: BRAND.gold })],
        ephemeral: true,
      });
    }
    case 'season-apply': {
      await i.defer(true);
      const rv = league.seasonReview(score.compute);
      for (const u of rv.up) { members.moveLeague(u.userId, 'NL'); await syncLeagueRoles(u.userId, 'NL'); }
      for (const d of rv.down) { members.moveLeague(d.userId, 'HL'); await syncLeagueRoles(d.userId, 'HL'); }
      if (rv.up.length) settings.set('leagues', 'HL,NL');
      await api.post('wire', {
        embeds: [ui.embed({
          title: `SEASON ${rv.season}  |  PROMOTION AND RELEGATION`,
          description: [...rv.up.map((u) => `⬆️ ${ui.mention(u.userId)} · ${u.why}`), ...rv.down.map((d) => `⬇️ ${ui.mention(d.userId)} · ${d.why}`)].join('\n') || 'No moves this season.',
          color: BRAND.gold,
        })],
      });
      return i.send({ embeds: [ui.ok(`Moved ${rv.up.length} up and ${rv.down.length} down. Assign their new teams with \`/commish team-assign\`.`)] });
    }
    case 'eliminate': {
      const team = league.eliminate(lg, i.str('team'), !!i.bool('undo'));
      return i.reply({ embeds: [ui.ok(`${team} ${i.bool('undo') ? 'is back in contention' : 'is eliminated. Their wins now count in the Draft Race, and beating a contender pays a Spoiler Bounty'}.`)], ephemeral: true });
    }
    case 'deadline': {
      settings.set(`trade_deadline:${lg}`, i.int('week') || null);
      return i.reply({ embeds: [ui.ok(i.int('week') ? `${LEAGUES[lg]} trade deadline: after week ${i.int('week')}.` : 'Trade deadline cleared.')], ephemeral: true });
    }
    case 'unfreeze': {
      db.run('UPDATE members SET trade_unfrozen_season = ? WHERE user_id = ?', settings.season(), i.get('member'));
      return i.reply({ embeds: [ui.ok(`${ui.mention(i.get('member'))} can trade again this season.`)], ephemeral: true });
    }
    default: throw new UserError('Unknown option.');
  }
}

async function importModal(i) {
  requireStaff(i);
  const [, , lg, wk] = i.args;
  const week = Number(wk);
  await i.defer(true);
  const { added, errors } = games.importSchedule(lg, week, i.field('lines'));
  let posted = 0;
  if (week === settings.week(lg)) posted = await gameView.postWeek(lg, week);
  const cpu = added.filter((g) => g.status === 'cpu').length;
  const lines = [`Imported **${added.length}** game(s) for ${LEAGUES[lg]} week ${week}${cpu ? ` (${cpu} CPU)` : ''}.`];
  if (posted) lines.push(`Posted ${posted} game thread(s) now, since week ${week} is the current week.`);
  else if (week !== settings.week(lg)) lines.push(`Game threads post automatically when the league advances into week ${week}.`);
  if (errors.length) lines.push('', '**Skipped:**', ...errors.slice(0, 15).map((e) => `• ${e}`));
  await i.send({ embeds: [errors.length ? ui.info(lines.join('\n')) : ui.ok(lines.join('\n'))] });
}

async function teamAutocomplete(i) {
  const q = String((i.focused() || {}).value || '').toLowerCase();
  await i.autocomplete(TEAMS.filter((t) => `${t.city} ${t.name} ${t.abbr}`.toLowerCase().includes(q)).map((t) => ({ name: `${t.city} ${t.name}`, value: t.name })));
}

const leagueOpt = (required = true) => b.str('league', 'Which league', { required, choices: b.leagueChoices });

module.exports = {
  commands: [
    {
      def: b.command('commish', 'Staff: teams, schedule, advances, seasons', [
        b.sub('team-assign', 'Give a member a team', [b.user('member', 'Member', { required: true }), b.str('team', 'Team', { required: true, autocomplete: true }), leagueOpt()]),
        b.sub('team-remove', 'Take a member\'s team away', [b.user('member', 'Member', { required: true })]),
        b.sub('teams', 'Who owns which team', [leagueOpt()]),
        b.sub('move', 'Move a member to another league', [b.user('member', 'Member', { required: true }), leagueOpt()]),
        b.sub('remove-member', 'Remove a member from the league', [b.user('member', 'Member', { required: true }), b.bool('alumni', 'Left in good standing (can return)')]),
        b.sub('schedule-import', 'Paste a week of matchups', [leagueOpt(), b.int('week', 'Week number', { required: true, min: 0, max: 30 })]),
        b.sub('schedule-clear', 'Delete a week\'s unplayed matchups', [leagueOpt(), b.int('week', 'Week number', { required: true, min: 0, max: 30 })]),
        b.sub('repost', 'Post any missing game threads for a week', [leagueOpt(), b.int('week', 'Week (default: current)', { min: 0, max: 30 })]),
        b.sub('advance', 'Advance now: closes the week and opens the next', [
          b.str('which', 'Which league (default: all)', { choices: [{ name: 'All leagues', value: 'all' }, ...b.leagueChoices] }),
          b.int('week', 'Advance to this week (default: next)', { min: 0, max: 30 }),
        ]),
        b.sub('advance-delay', 'Move the next advance to tomorrow 8 PM PT'),
        b.sub('advance-set', 'Set the next advance time (PT)', [b.str('day', 'Day', { required: true, choices: b.dayChoices }), b.str('time', 'Time in PT, like 8 PM', { required: true, max: 12 })]),
        b.sub('activate', 'Turn a league on or off', [leagueOpt(), b.bool('on', 'On (default) or off')]),
        b.sub('season-start', 'Start a new season', [b.int('number', 'Season number', { required: true, min: 1, max: 99 })]),
        b.sub('champions', 'Record the champion and runner-up', [leagueOpt(), b.user('champion', 'Champion', { required: true }), b.user('runner_up', 'Runner-up', { required: true })]),
        b.sub('season-review', 'Preview promotion and relegation'),
        b.sub('season-apply', 'Apply promotion and relegation'),
        b.sub('eliminate', 'Mark a team out of contention (Nothing To Lose)', [leagueOpt(), b.str('team', 'Team', { required: true, autocomplete: true }), b.bool('undo', 'Put them back in contention')]),
        b.sub('deadline', 'Set the trade deadline week (blank clears it)', [leagueOpt(), b.int('week', 'Last week trades are allowed', { min: 0, max: 30 })]),
        b.sub('unfreeze', 'Let a member with 3+ strikes trade again', [b.user('member', 'Member', { required: true })]),
      ], 'staff'),
      run: leagueCommand,
      autocomplete: teamAutocomplete,
    },
    {
      def: b.command('matchups', 'This week\'s matchups and game times', [leagueOpt(false), b.int('week', 'Week (default: current)', { min: 0, max: 30 })]),
      run: async (i) => {
        const me = members.get(i.userId);
        const lg = i.str('league') || (me && me.league) || 'HL';
        await i.reply({ embeds: [scheduleView.scheduleEmbed(lg, i.int('week') ?? settings.week(lg))], ephemeral: true });
      },
    },
    {
      def: b.command('tonight', 'Tonight on THN: every locked game and where to watch'),
      run: async (i) => {
        const e = scheduleView.tonightEmbed();
        await i.reply({ embeds: [e || ui.info('No locked games left tonight. Check `/matchups` for this week.')] });
      },
    },
    {
      def: b.command('draftrace', 'Gold Plan Draft Race: eliminated teams ranked by wins since elimination', [leagueOpt(false)]),
      run: async (i) => {
        const lg = i.str('league') || (members.get(i.userId) || {}).league || 'HL';
        const rows = league.draftRace(lg);
        const desc = rows.length
          ? rows.map((r, n) => `**${n + 1}.** ${r.team}${r.userId ? ` (${ui.mention(r.userId)})` : ''} · ${r.wins} win${r.wins === 1 ? '' : 's'} since week ${r.since}`).join('\n')
          : 'No teams eliminated yet. Every team is still alive.';
        await i.reply({ embeds: [ui.embed({ title: `${LEAGUES[lg].toUpperCase()}  |  DRAFT RACE`, description: `${desc}\n\nWins after elimination set the top of the draft. Nothing to lose, everything to play for.`, color: BRAND.black })] });
      },
    },
  ],
  modals: { 'league:schedm': importModal },
  runAdvance,
};

'use strict';
// Creator Score, In The Stands, THN Passport, Huddle Awards, and the staff HQ.
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const settings = require('../settings');
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const { UserError } = require('../bus');
const members = require('../services/members');
const games = require('../services/games');
const score = require('../services/score');
const stands = require('../services/stands');
const awards = require('../services/awards');
const trades = require('../services/trades');
const clipsSvc = require('../services/clips');
const academy = require('../services/academy');
const shop = require('../services/shop');
const credits = require('../services/credits');
const gameView = require('../views/game');
const scheduleView = require('../views/schedule');
const clipsModule = require('./clips');
const { profileEmbed } = require('./members');
const { ts, weekStart, weekday, DAY } = require('../lib/time');
const { BRAND, LEAGUES, AWARD_CATEGORIES, MEDIA_SLATE } = require('../constants');

// ---------- boards and briefs (also used by the scheduler) ----------

function reliabilityBoard() {
  const rows = members.active().filter((m) => m.team).map((m) => ({ m, st: games.memberStats(m.user_id) }))
    .filter((x) => x.st.timed || x.st.counted);
  if (!rows.length) return null;
  const rate = (n, d) => (d ? n / d : 0);
  rows.sort((a, b) => rate(b.st.ontime, b.st.timed) - rate(a.st.ontime, a.st.timed) || (b.m.ontime_streak || 0) - (a.m.ontime_streak || 0));
  const top = rows.slice(0, 15).map((x, n) => `**${n + 1}.** ${x.m.streamer_name || ui.mention(x.m.user_id)} · ⏱️ ${ui.pct(x.st.ontime, x.st.timed) ?? '—'}% · ✅ ${ui.pct(x.st.complete, x.st.counted) ?? '—'}%${x.m.ontime_streak >= 3 ? ` · 🔥${x.m.ontime_streak}` : ''}`);
  const prime = rows.filter((x) => games.primeTimeEligible(x.m.user_id).ok).length;
  const network = rows.reduce((a, x) => ({ on: a.on + x.st.ontime, t: a.t + x.st.timed, c: a.c + x.st.complete, n: a.n + x.st.counted }), { on: 0, t: 0, c: 0, n: 0 });
  return ui.embed({
    title: 'RELIABILITY BOARD',
    description: `${top.join('\n')}\n\n**Network:** ${ui.pct(network.on, network.t) ?? '—'}% on time · ${ui.pct(network.c, network.n) ?? '—'}% complete\n**Prime Time eligible:** ${prime} member${prime === 1 ? '' : 's'} (${settings.limit('primeTimeOnTime')}%+ on time, ${settings.limit('primeTimeComplete')}%+ complete)`,
    footer: '⏱️ on time · ✅ completed · 🔥 on-time streak',
    color: BRAND.silver, timestamp: true,
  });
}

function mediaBrief(now = Date.now()) {
  const wd = weekday(now);
  const show = MEDIA_SLATE[wd];
  if (!show) return null;
  const lines = [];
  const since = now - 7 * DAY;
  if (show === 'Power Rankings') {
    for (const l of settings.activeLeagues()) {
      const ranked = members.inLeague(l).filter((m) => m.team).map((m) => ({ m, r: games.teamRecord(l, m.team) }))
        .sort((a, b) => b.r.pct - a.r.pct || b.r.w - a.r.w).slice(0, 10);
      if (ranked.length) lines.push(`**${LEAGUES[l]}**`, ...ranked.map((x, n) => `${n + 1}. ${x.m.team} (${games.recordText(x.r)}) · ${x.m.streamer_name || ''}`));
    }
  } else if (show === 'Top 5 Plays') {
    const list = clipsSvc.thisWeek(since).filter((c) => ['Play of the Week', 'Clutch', 'Big Moment', 'Spoiler'].includes(c.type)).slice(0, 10);
    lines.push(...(list.length ? list.map((c) => `#${c.id} ${c.type} · ${ui.mention(c.user_id)} · ${c.url}`) : ['No accepted play clips this week. Nudge members to `/clip submit`.']));
  } else if (show === 'Creator Spotlight') {
    const top = score.leaderboard(null, 5);
    lines.push('Top Creator Scores right now:', ...top.map((x) => `${x.member.streamer_name || ui.mention(x.member.user_id)} · ${x.ovr} OVR`));
  } else if (show === 'Game of the Week Preview') {
    const g = db.one("SELECT * FROM games WHERE gotw = 1 AND status IN ('scheduled','locked') ORDER BY id DESC LIMIT 1");
    if (g) {
      const a = games.teamRecord(g.league, g.away_team);
      const h = games.teamRecord(g.league, g.home_team);
      lines.push(`**${g.away_team} (${games.recordText(a)}) @ ${g.home_team} (${games.recordText(h)})**`, g.locked_at ? `Kickoff ${ts(g.locked_at, 'F')}` : 'Not locked yet.');
    } else lines.push('No Game of the Week picked yet. `/hq gotw-candidates` shows eligible games.');
  } else if (show === 'Huddle Headlines') {
    const tr = db.all("SELECT * FROM trades WHERE status = 'approved' AND decided_at >= ?", since);
    const spoilers = db.all("SELECT * FROM ledger WHERE category = 'spoilerBounty' AND created_at >= ?", since);
    lines.push(`**Trades approved:** ${tr.length ? tr.map((t) => `${t.from_team} ⇄ ${t.to_team}`).join(', ') : 'none'}`);
    lines.push(`**Spoiler Bounties:** ${spoilers.length ? spoilers.map((s) => ui.mention(s.user_id)).join(', ') : 'none'}`);
    const bd = reliabilityBoard();
    if (bd) lines.push('', 'Reliability leaders are on the board for a quick segment.');
  } else if (show === 'Weekend Recap') {
    const done = db.all(`SELECT * FROM games WHERE status = 'complete' AND completed_at >= ? ORDER BY completed_at DESC LIMIT 15`, now - 3 * DAY);
    lines.push(...(done.length ? done.map((g) => `${g.away_team} ${g.away_score}, ${g.home_team} ${g.home_score}${g.gotw ? ' ⭐' : ''}`) : ['No finals since Friday.']));
  }
  return ui.embed({ title: `MEDIA DESK  |  TODAY: ${show.toUpperCase()}`, description: lines.join('\n') || 'Nothing to report yet.', color: BRAND.black, timestamp: true, footer: 'Daily brief' });
}

function dashboard() {
  const next = games.nextAdvance();
  const fields = [];
  for (const l of settings.activeLeagues()) {
    const wk = settings.week(l);
    const list = games.weekGames(l, wk).filter((g) => g.status !== 'cpu');
    const by = (s) => list.filter((g) => g.status === s);
    const unlocked = by('scheduled');
    fields.push({
      name: `${LEAGUES[l]} · week ${wk}`,
      value: [
        `${list.length} games · 🔒 ${by('locked').length} · 🏈 ${by('kicked').length} · 📝 ${by('final_pending').length} · ✅ ${list.filter((g) => games.FINISHED.includes(g.status)).length}`,
        unlocked.length ? `Not locked: ${unlocked.slice(0, 8).map((g) => `${g.away_team}@${g.home_team}`).join(', ')}${unlocked.length > 8 ? '…' : ''}` : 'Every game is locked.',
      ].join('\n'),
    });
  }
  const count = (sql, ...p) => db.one(sql, ...p).n;
  fields.push({
    name: 'Waiting on staff',
    value: [
      `⛔ Unplayed games to rule: ${count("SELECT COUNT(*) AS n FROM games WHERE status = 'unplayed'")}`,
      `⚠️ Score disputes: ${db.all("SELECT flags FROM games WHERE status = 'final_pending'").filter((g) => games.flags(g).disputed).length}`,
      `🗳️ Trades in committee: ${count("SELECT COUNT(*) AS n FROM trades WHERE status = 'voting'")}`,
      `🎬 Clips to review: ${clipsSvc.pending().length}`,
      `🎓 Academy check-ins: ${academy.pending().length}`,
      `🛒 Redemptions: ${shop.openRedemptions().length}`,
      `📋 Applications: ${count("SELECT COUNT(*) AS n FROM members WHERE status = 'applied'")}`,
      `🚩 Removal reviews: ${count("SELECT COUNT(*) AS n FROM reviews WHERE status = 'open'")}`,
    ].join('\n'),
  });
  const tonight = scheduleView.tonightGames();
  return ui.embed({
    title: `HUDDLE HQ  |  SEASON ${settings.season()}`,
    description: `**Next advance:** ${next ? `${ts(next, 'F')} (${ts(next, 'R')})` : 'not set'}\n**Tonight:** ${tonight.length} locked game${tonight.length === 1 ? '' : 's'}\n**Active members:** ${members.active().length}`,
    fields, color: BRAND.red, timestamp: true,
  });
}

function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

function backupFiles() {
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(os.tmpdir(), `huddle-hq-${stamp}.db`);
  db.backupTo(file);
  const out = [{ name: `huddle-hq-${stamp}.db`, data: fs.readFileSync(file) }];
  fs.unlinkSync(file);
  out.push({ name: `members-${stamp}.csv`, data: Buffer.from(csv(db.all('SELECT * FROM members'))) });
  out.push({ name: `games-${stamp}.csv`, data: Buffer.from(csv(db.all('SELECT g.*, a.user_id AS away_user, h.user_id AS home_user FROM games g LEFT JOIN game_players a ON a.game_id = g.id AND a.side = \'away\' LEFT JOIN game_players h ON h.game_id = g.id AND h.side = \'home\''))) });
  out.push({ name: `credits-${stamp}.csv`, data: Buffer.from(csv(db.all('SELECT * FROM ledger'))) });
  return out;
}

// ---------- commands ----------

async function hqCommand(i) {
  if (!i.isStaffOr('media', 'clipTeam')) throw new UserError('Only staff can use Huddle HQ.');
  const staffOnly = () => { if (!i.isStaff) throw new UserError('Only staff can do that.'); };
  switch (i.sub) {
    case 'dashboard': return i.reply({ embeds: [dashboard()], ephemeral: true });
    case 'backup': {
      staffOnly();
      await i.defer(true);
      return i.send({ content: 'Full backup: the .db file restores everything; the CSVs open in Sheets or Excel.', files: backupFiles() });
    }
    case 'score-rate': {
      staffOnly();
      const v = i.int('value');
      score.setRating(i.get('member'), i.str('category'), v === 0 ? null : v);
      return i.reply({ embeds: [ui.ok(`${score.CATEGORIES[i.str('category')].label} for ${ui.mention(i.get('member'))} ${v === 0 ? 'reset to automatic' : `set to ${v}`}. OVR is now ${score.compute(i.get('member')).ovr}.`)], ephemeral: true });
    }
    case 'gotw-candidates': {
      const lg = i.str('league') || 'HL';
      const list = games.weekGames(lg, settings.week(lg)).filter((g) => ['scheduled', 'locked'].includes(g.status));
      const ok = list.map((g) => {
        const ctx = games.load(g.id);
        if (!ctx.away || !ctx.home) return null;
        const ea = games.primeTimeEligible(ctx.away.user_id);
        const eh = games.primeTimeEligible(ctx.home.user_id);
        const ra = games.teamRecord(lg, g.away_team);
        const rh = games.teamRecord(lg, g.home_team);
        return { g, ok: ea.ok && eh.ok, combined: ra.pct + rh.pct, ra, rh };
      }).filter(Boolean).sort((a, b) => b.ok - a.ok || b.combined - a.combined);
      return i.reply({
        embeds: [ui.embed({
          title: `GAME OF THE WEEK CANDIDATES  |  ${LEAGUES[lg].toUpperCase()}`,
          description: ok.length ? ok.slice(0, 12).map((x) => `${x.ok ? '✅' : '🚫'} #${x.g.id} **${x.g.away_team} (${games.recordText(x.ra)}) @ ${x.g.home_team} (${games.recordText(x.rh)})**${x.g.locked_at ? ` · ${ts(x.g.locked_at, 'f')}` : ' · not locked'}`).join('\n') : 'No open games this week.',
          footer: '✅ both owners Prime Time eligible · pick with /hq gotw-set', color: BRAND.gold,
        })],
        ephemeral: true,
      });
    }
    case 'gotw-set': {
      const g = games.getGame(i.int('game'));
      if (!g) throw new UserError('Game not found.');
      db.run('UPDATE games SET gotw = 0 WHERE season = ? AND league = ? AND week = ?', g.season, g.league, g.week);
      db.run('UPDATE games SET gotw = 1 WHERE id = ?', g.id);
      await gameView.refresh(g.id);
      const ctx = games.load(g.id);
      await api.post('wire', {
        content: `${ui.mention(ctx.away && ctx.away.user_id)} ${ui.mention(ctx.home && ctx.home.user_id)}`,
        embeds: [ui.embed({
          title: '⭐ GAME OF THE WEEK',
          description: `**${g.away_team} (${games.recordText(games.teamRecord(g.league, g.away_team))}) @ ${g.home_team} (${games.recordText(games.teamRecord(g.league, g.home_team))})**\n${LEAGUES[g.league]} week ${g.week}${g.locked_at ? `\nKickoff ${ts(g.locked_at, 'F')}` : ''}\n\nPromoted across THN socials. Watermark required; 720p is fine.`,
          color: BRAND.gold,
        })],
      });
      await gameView.say(g.id, '⭐ This is the **Game of the Week**. THN is promoting it. Lock it in and start on time.');
      return i.reply({ embeds: [ui.ok(`Game of the Week: ${games.label(g)}.`)], ephemeral: true });
    }
    case 'clip-finalists': {
      const ids = String(i.str('clips')).split(/[^0-9]+/).filter(Boolean).map(Number);
      const p = await clipsModule.openVote(ids);
      return i.reply({ embeds: [ui.ok(`Clip of the Week vote is open with ${p.clips.length} finalists. It closes ${ts(p.closes_at, 'F')}.`)], ephemeral: true });
    }
    case 'clip-crown': {
      const open = clipsSvc.openPolls();
      if (!open.length) throw new UserError('No Clip of the Week vote is open.');
      const r = await clipsModule.closeVote(open[open.length - 1].id);
      return i.reply({ embeds: [ui.ok(`Clip #${r.winner.id} wins with ${r.votes} vote(s).`)], ephemeral: true });
    }
    case 'clip-views': {
      const r = clipsSvc.milestone(i.int('clip'), i.str('milestone'), i.userId);
      return i.reply({ embeds: [ui.ok(`Clip #${r.clip.id}: ${i.str('milestone').toUpperCase()} logged. +${r.paid} credits to ${ui.mention(r.clip.user_id)}.`)], ephemeral: true });
    }
    case 'event-open': {
      const e = stands.openEvent(i.str('name'), i.int('minutes') || 60, i.int('credits') ?? settings.credit('event'), i.userId);
      await i.reply({
        embeds: [ui.embed({ title: `📣 ${e.name.toUpperCase()}`, description: `Members: tap **I'm here** to check in. +${e.credits} credits.\nCheck-in closes ${ts(e.closes_at, 'R')}.`, color: BRAND.red })],
        components: ui.rows([ui.button(`event:here:${e.id}`, "I'm here", 'success', { emoji: '🙋' })]),
      });
      return null;
    }
    case 'passport-draw': {
      staffOnly();
      const r = stands.draw();
      if (!r) throw new UserError('No Passport stamps this month yet.');
      await api.post('passport', { embeds: [ui.embed({ title: '🎟️ THN PASSPORT GIVEAWAY', description: `This month's winner: ${ui.mention(r.winner)}!\n${r.players} fans entered with ${r.entries} total entries. Thanks for watching the network.`, color: BRAND.gold })] });
      return i.reply({ embeds: [ui.ok(`Winner: ${ui.mention(r.winner)} (${r.weight} of ${r.entries} entries).`)], ephemeral: true });
    }
    case 'awards-open': {
      staffOnly();
      awards.setOpen(true);
      await api.post('wire', { embeds: [ui.embed({ title: `🏆 HUDDLE AWARDS  |  SEASON ${settings.season()}`, description: `Voting is open. Members: \`/awards vote\` in each category (one vote each, not yourself).\n\n${AWARD_CATEGORIES.join(' · ')}`, color: BRAND.gold })] });
      return i.reply({ embeds: [ui.ok('Award voting is open.')], ephemeral: true });
    }
    case 'awards-close': {
      staffOnly();
      awards.setOpen(false);
      const res = awards.results();
      const data = awards.dataAwards();
      const lines = res.map((r) => `**${r.category}:** ${r.top[0] ? `${ui.mention(r.top[0].nominee_id)} (${r.top[0].n})` : 'no votes'}`);
      if (i.get('commissioner_award')) lines.push(`**Commissioner Award:** ${ui.mention(i.get('commissioner_award'))}`);
      lines.push('', `**Iron Clock (100% on time):** ${data.ironClock.length ? data.ironClock.map(ui.mention).join(' ') : 'none'}`);
      lines.push(`**Final Whistle (100% complete):** ${data.finalWhistle.length ? data.finalWhistle.map(ui.mention).join(' ') : 'none'}`);
      if (data.clipMachine) lines.push(`**Clip Machine:** ${ui.mention(data.clipMachine.user_id)} (${data.clipMachine.n} featured)`);
      if (data.mostViral) lines.push(`**Most Viral:** ${ui.mention(data.mostViral.user_id)} (clip #${data.mostViral.id})`);
      if (i.bool('announce')) await api.post('wire', { embeds: [ui.embed({ title: `🏆 HUDDLE AWARDS  |  SEASON ${settings.season()} WINNERS`, description: lines.join('\n'), color: BRAND.gold })] });
      return i.reply({ embeds: [ui.embed({ title: 'AWARD RESULTS', description: `${lines.join('\n')}${i.bool('announce') ? '' : '\n\nNot posted. Run again with announce: True to post on The Wire.'}`, color: BRAND.gold })], ephemeral: true });
    }
    case 'reviews': {
      const open = db.all("SELECT * FROM reviews WHERE status = 'open' ORDER BY id");
      return i.reply({ embeds: [ui.embed({ title: 'REMOVAL REVIEWS', description: open.length ? open.map((r) => `#${r.id} ${ui.mention(r.user_id)} · ${r.reason} · ${ts(r.created_at, 'R')}`).join('\n') : 'None open.', footer: 'Close one with /hq review-close', color: BRAND.silver })], ephemeral: true });
    }
    case 'review-close': {
      staffOnly();
      db.run("UPDATE reviews SET status = 'closed' WHERE id = ?", i.int('id'));
      return i.reply({ embeds: [ui.ok(`Review #${i.int('id')} closed.`)], ephemeral: true });
    }
    case 'post': {
      const what = i.str('what');
      const payload = what === 'tonight' ? scheduleView.tonightEmbed() : what === 'board' ? reliabilityBoard() : mediaBrief();
      if (!payload) throw new UserError('Nothing to post right now.');
      await api.post(what === 'tonight' ? 'tonight' : what === 'board' ? 'reliability' : 'mediaDesk', { embeds: [payload] });
      return i.reply({ embeds: [ui.ok('Posted.')], ephemeral: true });
    }
    default: throw new UserError('Unknown option.');
  }
}

async function standsCommand(i) {
  if (i.sub === 'scout') {
    const opp = i.get('opponent');
    return i.showModal(ui.modal(`stands:scoutm:${opp}`, 'SCOUTING REPORT', [
      { id: 'off', label: 'What they run on offense', paragraph: true, max: 400 },
      { id: 'def', label: 'What they run on defense', paragraph: true, max: 400 },
      { id: 'key', label: 'Key players and tendencies', paragraph: true, max: 400 },
      { id: 'vod', label: 'Stream or VOD you watched', required: false, max: 200 },
    ]));
  }
  if (i.sub === 'raid') {
    const target = i.get('target');
    if (target === i.userId) throw new UserError('You can\'t raid yourself.');
    const tm = members.get(target);
    if (!tm || tm.status !== 'active') throw new UserError('That streamer isn\'t a THN member.');
    await i.reply({
      content: `${ui.mention(target)}, ${ui.mention(i.userId)} says they raided you. Tap to confirm.`,
      components: ui.rows([ui.button(`raid:ok:${i.userId}:${target}:${Date.now()}`, 'Confirm raid', 'success', { emoji: '🚀' })]),
    });
    return null;
  }
  if (i.sub === 'chat') {
    const ids = ['member1', 'member2', 'member3', 'member4', 'member5'].map((k) => i.get(k)).filter(Boolean);
    const res = stands.chat(i.userId, ids);
    const lines = res.map((r) => (r.ok ? `${ui.mention(r.id)} +${r.amount}` : `${ui.mention(r.id)} · ${r.capped ? 'weekly cap reached' : r.skipped || 'not credited'}`));
    return i.reply({ embeds: [ui.ok(`Active chat confirmed:\n${lines.join('\n')}`)], ephemeral: true });
  }
  throw new UserError('Unknown option.');
}

async function scoutModal(i) {
  const opp = i.args[2];
  const r = stands.scout(i.userId, opp);
  const m = members.get(i.userId);
  const om = members.get(opp);
  await api.post('scouting', {
    embeds: [ui.embed({
      title: `SCOUTING REPORT  |  ${(om && om.team ? om.team : 'OPPONENT').toUpperCase()}`,
      description: `By ${ui.mention(i.userId)}${m && m.team ? ` (${m.team})` : ''} on ${ui.mention(opp)}`,
      fields: [{ name: 'Offense', value: i.field('off') }, { name: 'Defense', value: i.field('def') }, { name: 'Key players and tendencies', value: i.field('key') },
        ...(i.field('vod') ? [{ name: 'Watched', value: i.field('vod') }] : [])],
      color: BRAND.black, timestamp: true,
    })],
  });
  await i.reply({ embeds: [ui.ok(r.ok ? `Report posted. +${r.amount} credits. Read it on stream before kickoff and build the rivalry.` : `Report posted. ${r.capped ? `You've hit the weekly cap of ${r.cap} paid reports.` : ''}`)], ephemeral: true });
}

module.exports = {
  commands: [
    {
      def: b.command('score', 'Huddle Creator Score', [
        b.sub('card', 'Creator card with OVR', [b.user('member', 'Whose (default: you)')]),
        b.sub('leaderboard', 'Top Creator Scores', [b.str('league', 'League', { choices: b.leagueChoices })]),
        b.sub('explain', 'How the Creator Score works'),
      ]),
      run: async (i) => {
        if (i.sub === 'card') {
          const target = i.get('member') || i.userId;
          const roles = target === i.userId ? i.roles : (i.resolved.members && i.resolved.members[target] ? i.resolved.members[target].roles : null);
          return i.reply({ embeds: [profileEmbed(target, roles)] });
        }
        if (i.sub === 'explain') {
          return i.reply({
            embeds: [ui.embed({ title: 'HOW THE CREATOR SCORE WORKS', description: Object.values(score.CATEGORIES).map((c) => `**${c.label}** (${Math.round(c.weight * 100)}%): ${c.source}`).join('\n') + `\n\nOVR runs 40 to 99. The top 2 Huddle League streamers by OVR earn promotion; Network League members under ${settings.limit('creatorScoreMin')} risk relegation.`, color: BRAND.black })],
            ephemeral: true,
          });
        }
        const list = score.leaderboard(i.str('league'), 15);
        return i.reply({ embeds: [ui.embed({ title: `CREATOR SCORE LEADERS${i.str('league') ? `  |  ${LEAGUES[i.str('league')].toUpperCase()}` : ''}`, description: list.length ? list.map((x, n) => `**${n + 1}.** ${x.member.streamer_name || ui.mention(x.member.user_id)} · **${x.ovr} OVR**`).join('\n') : 'No members yet.', color: BRAND.red })] });
      },
    },
    {
      def: b.command('stands', 'In The Stands: support other THN members', [
        b.sub('scout', 'Post a Scouting Report on your next opponent', [b.user('opponent', 'Who you scouted', { required: true })]),
        b.sub('raid', 'Log a raid to a live THN member (they confirm)', [b.user('target', 'Who you raided', { required: true })]),
        b.sub('chat', 'Streamers: confirm members who were active in your chat', [
          b.user('member1', 'Member', { required: true }), b.user('member2', 'Member'), b.user('member3', 'Member'), b.user('member4', 'Member'), b.user('member5', 'Member'),
        ]),
      ]),
      run: standsCommand,
    },
    {
      def: b.command('passport', 'THN Passport: collect stamps by watching THN streams live', [
        b.sub('stamp', 'Enter a code word you saw on stream', [b.str('code', 'The code word', { required: true, max: 30 })]),
        b.sub('card', 'Your Passport', [b.user('member', 'Whose (default: you)')]),
        b.sub('code', 'Streamers: get a fresh code for this stream'),
      ]),
      run: async (i) => {
        if (i.sub === 'stamp') {
          const r = stands.stamp(i.userId, i.str('code'));
          for (const role of r.roles) await api.addRoleFor(i.userId, role, 'THN Passport');
          const sm = members.get(r.streamerId);
          return i.reply({ embeds: [ui.ok(`Stamped: **${(sm && sm.streamer_name) || 'THN stream'}**${r.newChannel ? ' (new channel, bonus points)' : ''}.\nThis month: ${r.month.stamps} stamps from ${r.month.channels} channels · ${r.month.points} giveaway entries.${r.roles.length ? `\nNew role unlocked: ${r.roles.map((x) => (x === 'fan' ? 'THN Fan' : 'THN Superfan')).join(', ')}!` : ''}`, 'THN PASSPORT')], ephemeral: true });
        }
        if (i.sub === 'code') {
          const m = members.get(i.userId);
          if (!m || m.status !== 'active') throw new UserError('Passport codes are for THN streamers.');
          const c = stands.newCode(i.userId);
          return i.reply({ embeds: [ui.embed({ title: 'YOUR PASSPORT CODE', description: `**${c.code}**\nShow it once on stream at a random moment. Valid until ${ts(c.expiresAt, 't')}. Your previous code stopped working.`, color: BRAND.black })], ephemeral: true });
        }
        const who = i.get('member') || i.userId;
        const mo = stands.points(who);
        const life = stands.lifetime(who);
        return i.reply({ embeds: [ui.embed({ title: 'THN PASSPORT', description: `${ui.mention(who)}\n\n**This month:** ${mo.stamps} stamps · ${mo.channels} channels · ${mo.points} giveaway entries\n**All time:** ${life.stamps} stamps · ${life.channels} channels\n\nStamps from different channels count double. Fan at ${settings.limit('fanPoints')} points, Superfan at ${settings.limit('superfanPoints')}.`, color: BRAND.gold })], ephemeral: true });
      },
    },
    {
      def: b.command('awards', 'Huddle Awards', [
        b.sub('vote', 'Vote in a category', [
          b.str('category', 'Award', { required: true, choices: AWARD_CATEGORIES.map((c) => ({ name: c, value: c })) }),
          b.user('nominee', 'Your pick', { required: true }),
        ]),
        b.sub('ballot', 'Your votes so far'),
      ]),
      run: async (i) => {
        if (i.sub === 'vote') {
          awards.vote(i.userId, i.str('category'), i.get('nominee'));
          return i.reply({ embeds: [ui.ok(`Vote saved: **${i.str('category')}** → ${ui.mention(i.get('nominee'))}. You can change it until voting closes.`)], ephemeral: true });
        }
        const mine = Object.fromEntries(awards.myBallot(i.userId).map((v) => [v.category, v.nominee_id]));
        return i.reply({ embeds: [ui.embed({ title: `YOUR BALLOT${awards.isOpen() ? '' : ' (voting closed)'}`, description: AWARD_CATEGORIES.map((c) => `**${c}:** ${mine[c] ? ui.mention(mine[c]) : '—'}`).join('\n'), color: BRAND.gold })], ephemeral: true });
      },
    },
    {
      def: b.command('hq', 'Staff: Huddle HQ', [
        b.sub('dashboard', 'Everything that needs attention'),
        b.sub('backup', 'Download a full backup (database + CSVs)'),
        b.sub('score-rate', 'Set a Creator Score category (0 = back to automatic)', [b.user('member', 'Member', { required: true }),
          b.str('category', 'Category', { required: true, choices: Object.entries(score.CATEGORIES).map(([value, c]) => ({ name: c.label, value })) }),
          b.int('value', 'Rating 40 to 99, or 0 to reset', { required: true, min: 0, max: 99 })]),
        b.sub('gotw-candidates', 'Game of the Week candidates', [b.str('league', 'League', { choices: b.leagueChoices })]),
        b.sub('gotw-set', 'Pick the Game of the Week', [b.int('game', 'Game number (from candidates)', { required: true, min: 1 })]),
        b.sub('clip-finalists', 'Open Clip of the Week voting', [b.str('clips', 'Up to 5 clip numbers, like 12, 15, 18', { required: true, max: 60 })]),
        b.sub('clip-crown', 'Close the vote now and crown the winner'),
        b.sub('clip-views', 'Log a clip view milestone on THN socials', [b.int('clip', 'Clip number', { required: true, min: 1 }),
          b.str('milestone', 'Views', { required: true, choices: [{ name: '1K', value: '1k' }, { name: '10K', value: '10k' }, { name: '100K', value: '100k' }] })]),
        b.sub('event-open', 'Post an event check-in button', [b.str('name', 'Event name', { required: true, max: 60 }), b.int('minutes', 'Check-in window (default 60)', { min: 5, max: 600 }), b.int('credits', 'Credits (default from settings)', { min: 0, max: 1000 })]),
        b.sub('passport-draw', 'Draw this month\'s Passport giveaway winner'),
        b.sub('awards-open', 'Open Huddle Awards voting'),
        b.sub('awards-close', 'Close voting and show results', [b.user('commissioner_award', 'Commissioner Award winner'), b.bool('announce', 'Post winners on The Wire')]),
        b.sub('reviews', 'Open removal reviews'),
        b.sub('review-close', 'Close a removal review', [b.int('id', 'Review number', { required: true, min: 1 })]),
        b.sub('post', 'Post a board now', [b.str('what', 'Which', { required: true, choices: [{ name: 'Tonight on THN', value: 'tonight' }, { name: 'Reliability Board', value: 'board' }, { name: 'Media brief', value: 'media' }] })]),
      ], 'staff'),
      run: hqCommand,
    },
  ],
  buttons: {
    raid: async (i) => {
      const [, , raider, target, at] = i.args;
      if (i.userId !== target) throw new UserError('Only the streamer who got raided can confirm.');
      if (Date.now() - Number(at) > 24 * 3600000) throw new UserError('This raid confirmation expired.');
      const r = stands.raid(raider, target, `raid:${target}:${at}`);
      await i.update({ content: `🚀 Raid confirmed: ${ui.mention(raider)} → ${ui.mention(target)}${r.ok ? ` · +${r.amount} credits` : r.capped ? ' · weekly raid cap reached' : ''}`, components: [] });
    },
    event: async (i) => {
      const r = stands.eventCheckIn(Number(i.args[2]), i.userId);
      if (r.notMember) return i.reply({ embeds: [ui.info(`Thanks for coming to ${r.event.name}! Event credits are for THN members.`)], ephemeral: true });
      return i.reply({ embeds: [r.ok ? ui.ok(`Checked in to ${r.event.name}. +${r.amount} credits.`) : ui.info('You\'re already checked in.')], ephemeral: true });
    },
  },
  modals: { 'stands:scoutm': scoutModal },
  reliabilityBoard,
  mediaBrief,
  dashboard,
  backupFiles,
};

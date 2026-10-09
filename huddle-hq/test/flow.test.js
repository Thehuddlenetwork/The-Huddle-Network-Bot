'use strict';
// End-to-end season walk-through against a fake Discord.
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./harness');

const realNow = Date.now;
let clock = Date.parse('2026-11-13T12:00:00-08:00'); // Fri Nov 13, noon PT (season 1 start)
Date.now = () => clock;
const at = (iso) => { clock = Date.parse(iso); };

const h = setup();
const settings = require('../src/settings');
const credits = require('../src/services/credits');
const strikes = require('../src/services/strikes');
const games = require('../src/services/games');
const members = require('../src/services/members');
const live = require('../src/live');
const scheduler = require('../src/scheduler');
const notify = require('../src/notify');
notify.attach();

const ADMIN = { id: '800000000000000001', name: 'jordan', perms: '8' };
const A = { id: '800000000000000101', name: 'alpha' };
const B = { id: '800000000000000102', name: 'bravo' };
const C = { id: '800000000000000103', name: 'charlie' };
const D = { id: '800000000000000104', name: 'delta' };
const V = { id: '800000000000000199', name: 'viewer' };
const K1 = { id: '800000000000000201', name: 'k1' };
const K2 = { id: '800000000000000202', name: 'k2' };

const ok = (r) => { assert.ok(!/Something went wrong/.test(r.all), `unexpected error: ${r.all.slice(0, 400)}`); return r; };
const userErr = (r, re) => assert.match(r.text, re);

test('setup creates channels and roles', async () => {
  const r = ok(await h.cmd(ADMIN, 'setup', 'auto'));
  assert.match(r.all, /SETUP COMPLETE/);
  for (const p of ['gamesHL', 'staffAlerts', 'wire', 'creditLog', 'goLive', 'tradeCommittee']) assert.ok(settings.channelId(p), `channel ${p}`);
  for (const p of ['member', 'leagueHL', 'committee', 'standard', 'pro', 'coach']) assert.ok(settings.roleId(p), `role ${p}`);
  const created = h.calls.filter((c) => c.method === 'POST' && /\/guilds\/\d+\/channels$/.test(c.path));
  const staffAlerts = created.find((c) => c.body.name === 'staff-alerts');
  assert.ok(staffAlerts.body.permission_overwrites.some((o) => o.id === h.GUILD && o.deny === '1024'), 'staff channel hidden from @everyone');
  ok(await h.cmd(ADMIN, 'setup', 'panel'));
  ok(await h.cmd(ADMIN, 'setup', 'credit', { rule: 'raid', value: 7 }));
  assert.strictEqual(settings.credit('raid'), 7);
});

test('members join, get approved and get teams', async () => {
  for (const [u, name, url, tz] of [[A, 'Alpha', 'twitch.tv/alpha', 'eastern'], [B, 'Bravo', 'https://www.youtube.com/@bravo', 'PT'], [C, 'Charlie', 'tiktok.com/@charlie', 'CST'], [D, 'Delta', 'twitch.tv/delta', 'mountain']]) {
    const r = ok(await h.modal(u, 'join:submit', { name, url, tag: `${name}_GT / PS5`, tz, avail: 'Weeknights' }));
    assert.match(r.text, /Application received/);
  }
  assert.strictEqual(members.get(A.id).twitch_login, 'alpha');
  assert.strictEqual(members.get(A.id).timezone, 'ET');
  assert.strictEqual(members.get(C.id).timezone, 'CT');

  // availability selects
  ok(await h.select(A, 'avail:days', ['5', '6', '7']));
  ok(await h.select(A, 'avail:windows', ['prime', 'late']));
  assert.strictEqual(members.get(A.id).avail_windows, 'prime,late');

  // non-staff can't approve
  userErr(await h.button(B, `app:approve:${A.id}`), /Only staff/);
  for (const u of [A, B, C, D]) ok(await h.button(ADMIN, `app:approve:${u.id}`));
  assert.strictEqual(members.get(A.id).status, 'active');
  assert.ok(h.memberRoles.get(A.id).has(settings.roleId('member')));

  ok(await h.select(ADMIN, `teamsel:${A.id}:HL:AFC`, ['Raiders']));
  ok(await h.cmd(ADMIN, 'commish', 'team-assign', { member: B.id, team: 'Chiefs', league: 'HL' }));
  ok(await h.cmd(ADMIN, 'commish', 'team-assign', { member: C.id, team: 'Bills', league: 'HL' }));
  ok(await h.cmd(ADMIN, 'commish', 'team-assign', { member: D.id, team: 'Dolphins', league: 'HL' }));
  userErr(await h.cmd(ADMIN, 'commish', 'team-assign', { member: D.id, team: 'Chiefs', league: 'HL' }), /already belong/);
  assert.strictEqual(members.get(A.id).team, 'Raiders');
});

test('schedule import and advance post game threads', async () => {
  ok(await h.modal(ADMIN, 'league:schedm:HL:1', { lines: 'Raiders @ Chiefs\nBills @ Dolphins\nJets @ Patriots\nRaiders @ Bills\nGarbage line' }));
  const wk1 = games.weekGames('HL', 1);
  assert.strictEqual(wk1.length, 3, 'duplicate team and bad line skipped');
  assert.strictEqual(wk1.find((g) => g.away_team === 'Jets').status, 'cpu');

  const r = ok(await h.cmd(ADMIN, 'commish', 'advance'));
  assert.match(r.all, /ADVANCED/);
  assert.strictEqual(settings.week('HL'), 1);
  const g = games.weekGames('HL', 1).find((x) => x.away_team === 'Raiders');
  assert.ok(g.message_id && g.thread_id, 'game post and thread created');
  assert.ok(g.advance_at);
  assert.strictEqual(games.nextAdvance(), Date.parse('2026-11-16T20:00:00-08:00'), 'next advance Monday 8 PM PT');
});

let gameAB;
let gameCD;
test('lock a time: suggest, propose, confirm, Lock In credits', async () => {
  gameAB = games.weekGames('HL', 1).find((x) => x.away_team === 'Raiders').id;
  gameCD = games.weekGames('HL', 1).find((x) => x.away_team === 'Bills').id;
  at('2026-11-13T13:00:00-08:00');

  const s = ok(await h.button(A, `game:suggest:${gameAB}`));
  assert.match(s.text, /GAME SCHEDULER/);
  assert.match(s.text, /game:pick:/);

  userErr(await h.button(C, `game:suggest:${gameAB}`), /Only the two owners/);

  ok(await h.cmd(A, 'game', 'time', { day: 'sat', time: '6:00 PM', timezone: 'PT' }));
  const proposed = games.getGame(gameAB);
  assert.strictEqual(proposed.proposed_at, Date.parse('2026-11-14T18:00:00-08:00'));

  userErr(await h.button(A, `game:confirm:${gameAB}:${proposed.proposed_at}`), /opponent has to confirm/);
  userErr(await h.button(B, `game:confirm:${gameAB}:123`), /replaced/);
  ok(await h.button(B, `game:confirm:${gameAB}:${proposed.proposed_at}`));
  const locked = games.getGame(gameAB);
  assert.strictEqual(locked.status, 'locked');
  assert.strictEqual(credits.balance(A.id), 5);
  assert.strictEqual(credits.balance(B.id), 5);

  // Too late: after the 2-hour buffer before the next advance
  userErr(await h.cmd(C, 'game', 'time', { day: 'mon', time: '7:00 PM', timezone: 'PT' }), /has to be by/);
  // C/D lock Sunday 1 PM PT via the custom-time modal (CT time typed)
  ok(await h.modal(C, `game:timem:${gameCD}`, { day: 'sun', time: '3:00 PM', tz: 'CT' }));
  const cd = games.getGame(gameCD);
  assert.strictEqual(cd.proposed_at, Date.parse('2026-11-15T13:00:00-08:00'));
  ok(await h.button(D, `game:confirm:${gameCD}:${cd.proposed_at}`));
  assert.strictEqual(credits.balance(C.id), 5);
});

test('go live, kickoff on time, final, credits', async () => {
  at('2026-11-14T17:20:00-08:00'); // 40 min before kickoff
  const gl = ok(await h.cmd(A, 'golive'));
  assert.match(gl.text, /You're live/);
  assert.ok(h.posts(settings.channelId('goLive')).length >= 1, 'go-live alert posted');
  assert.ok(games.getPlayer(gameAB, 'away').checkin_at, 'A checked in');

  // B goes live on YouTube, seen through Discord presence
  at('2026-11-14T17:58:00-08:00');
  await live.onPresence({ user: { id: B.id }, activities: [{ type: 1, url: 'https://youtube.com/watch?v=x', name: 'YouTube' }] });
  assert.ok(games.getPlayer(gameAB, 'home').checkin_at, 'B checked in from presence');

  at('2026-11-14T18:04:00-08:00');
  const k = ok(await h.cmd(A, 'game', 'kickoff'));
  assert.ok(k);
  assert.strictEqual(games.getPlayer(gameAB, 'away').timing, 'ontime');
  assert.strictEqual(games.getPlayer(gameAB, 'home').timing, 'ontime');
  assert.strictEqual(credits.balance(A.id), 15);

  at('2026-11-14T19:10:00-08:00');
  ok(await h.modal(A, `game:finalm:${gameAB}`, { away: '24', home: '21' }));
  assert.strictEqual(games.getGame(gameAB).status, 'final_pending');
  userErr(await h.button(A, `game:finalok:${gameAB}`), /opponent confirms/);
  ok(await h.button(B, `game:finalok:${gameAB}`));
  const g = games.getGame(gameAB);
  assert.strictEqual(g.status, 'complete');
  assert.strictEqual(g.winner, 'away');
  // lockIn 5 + onTime 10 + complete 10 + double 5
  assert.strictEqual(credits.balance(A.id), 30);
  assert.strictEqual(credits.balance(B.id), 30);
  assert.strictEqual(members.get(A.id).ontime_streak, 1);

  ok(await h.modal(B, `game:vodm:${gameAB}`, { url: 'youtube.com/watch?v=vod' }));
  assert.strictEqual(credits.balance(B.id), 35);
  // Paying twice is impossible
  games.settle(gameAB, 'home');
  assert.strictEqual(credits.balance(B.id), 35);
});

test('no kickoff at T+30: reminders, alert, no-show ruling', async () => {
  at('2026-11-15T12:46:00-08:00'); // T-14
  await scheduler.gameReminders(Date.now());
  assert.ok(games.flags(games.getGame(gameCD)).r15);
  ok(await h.cmd(C, 'golive', undefined, {}));
  at('2026-11-15T12:51:00-08:00'); // T-9
  await scheduler.gameReminders(Date.now());
  at('2026-11-15T13:31:00-08:00'); // T+31
  const before = h.calls.length;
  await scheduler.gameReminders(Date.now());
  const alert = h.calls.slice(before).find((c) => c.path === `/channels/${settings.channelId('staffAlerts')}/messages`);
  assert.ok(alert, 'staff alert posted');
  assert.match(JSON.stringify(alert.body), new RegExp(`rule:ns:${gameCD}:away`));

  userErr(await h.button(C, `rule:ns:${gameCD}:away`), /Only staff/);
  ok(await h.button(ADMIN, `rule:ns:${gameCD}:away`));
  const g = games.getGame(gameCD);
  assert.strictEqual(g.status, 'forcewin');
  assert.strictEqual(g.winner, 'away');
  assert.strictEqual(strikes.count(D.id), 1);
  assert.strictEqual(strikes.count(D.id, settings.season(), 'noshow'), 1);
});

test('late kickoff earns a strike and resets the streak', async () => {
  ok(await h.modal(ADMIN, 'league:schedm:HL:2', { lines: 'Chiefs @ Raiders\nDolphins @ Bills' }));
  at('2026-11-16T20:01:00-08:00');
  const adv = ok(await h.cmd(ADMIN, 'commish', 'advance'));
  assert.match(adv.all, /WEEK 2/);
  const g2 = games.weekGames('HL', 2).find((x) => x.home_team === 'Raiders').id;
  ok(await h.cmd(B, 'game', 'time', { day: 'tue', time: '7:00 PM', timezone: 'PT' }));
  ok(await h.button(A, `game:confirm:${g2}:${games.getGame(g2).proposed_at}`));
  at('2026-11-17T19:22:00-08:00'); // 22 min late, nobody checked in
  ok(await h.button(A, `game:kickoff:${g2}`));
  assert.strictEqual(games.getPlayer(g2, 'home').timing, 'very_late');
  assert.strictEqual(strikes.count(A.id), 1);
  assert.strictEqual(strikes.count(B.id), 1);
  assert.strictEqual(members.get(A.id).ontime_streak, 0);
  const strikePosts = h.posts(settings.channelId('strikeLog'));
  assert.ok(strikePosts.length >= 3);
});

test('audible: rescheduling with notice uses one of two', async () => {
  const g = games.weekGames('HL', 2).find((x) => x.home_team === 'Bills').id;
  at('2026-11-17T09:00:00-08:00');
  ok(await h.cmd(C, 'game', 'time', { day: 'tue', time: '8:00 PM', timezone: 'PT' }));
  ok(await h.button(D, `game:confirm:${g}:${games.getGame(g).proposed_at}`));
  ok(await h.cmd(D, 'game', 'time', { day: 'wed', time: '12:00 PM', timezone: 'PT' }));
  const r = ok(await h.button(C, `game:confirm:${g}:${games.getGame(g).proposed_at}`));
  assert.match(r.all, /AUDIBLE LOCKED/);
  assert.strictEqual(games.getGame(g).locked_at, Date.parse('2026-11-18T12:00:00-08:00'));
  assert.strictEqual(games.getPlayer(g, 'away').no_credit, 0);
  // Short-notice audible (under 6 hrs)
  at('2026-11-18T09:00:00-08:00');
  ok(await h.cmd(D, 'game', 'time', { day: 'wed', time: '2:00 PM', timezone: 'PT' }));
  ok(await h.button(C, `game:confirm:${g}:${games.getGame(g).proposed_at}`));
  assert.strictEqual(games.getPlayer(g, 'away').no_credit, 1, 'D (away? no) check side');
});

test('unplayed games at advance go to staff with ruling buttons', async () => {
  at('2026-11-18T20:02:00-08:00');
  const before = h.calls.length;
  ok(await h.cmd(ADMIN, 'commish', 'advance'));
  const unplayed = games.weekGames('HL', 2).filter((g) => g.status === 'unplayed');
  assert.strictEqual(unplayed.length, 2, 'kicked-but-unreported and never-played both flagged');
  const alerts = h.calls.slice(before).filter((c) => c.path === `/channels/${settings.channelId('staffAlerts')}/messages` && /UNPLAYED/.test(JSON.stringify(c.body)));
  assert.strictEqual(alerts.length, 2);
  ok(await h.button(ADMIN, `rule:sim:${unplayed[0].id}`));
  assert.strictEqual(games.getGame(unplayed[0].id).status, 'sim');
  ok(await h.cmd(ADMIN, 'ruling', 'doubleloss', { game: unplayed[1].id }));
  assert.strictEqual(games.getGame(unplayed[1].id).status, 'double_loss');
});

test('advance rollover: missed 8 PM moves to tomorrow', async () => {
  const next = games.nextAdvance();
  assert.strictEqual(next, Date.parse('2026-11-20T20:00:00-08:00'));
  at('2026-11-20T21:01:00-08:00');
  await scheduler.advanceClock(Date.now());
  assert.strictEqual(games.nextAdvance(), Date.parse('2026-11-21T20:00:00-08:00'));
});

test('trade desk: propose, accept with WHY, committee approves, Trade Wire', async () => {
  K1.roles = [settings.roleId('committee')];
  K2.roles = [settings.roleId('committee')];
  // A has 1 strike (not frozen). Propose to B.
  ok(await h.modal(A, `trade:proposem:${B.id}`, { send: 'WR X (85)', get: '2027 1st', why: 'Rebuilding' }));
  const t = require('../src/services/trades').recent(1)[0];
  assert.strictEqual(t.status, 'pending_partner');
  userErr(await h.button(C, `trade:accept:${t.id}`), /Only the other team/);
  ok(await h.modal(B, `trade:acceptm:${t.id}`, { why: 'Need a WR1 now' }));
  userErr(await h.button(C, `trade:vote:${t.id}:yes`), /trade committee/);
  ok(await h.button(K1, `trade:vote:${t.id}:yes`));
  const before = h.calls.length;
  ok(await h.button(K2, `trade:vote:${t.id}:yes`));
  assert.strictEqual(require('../src/services/trades').get(t.id).status, 'approved');
  assert.ok(h.calls.slice(before).some((c) => c.path === `/channels/${settings.channelId('wire')}/messages` && /TRADE WIRE/.test(JSON.stringify(c.body))));
});

test('trade auto-passes after 24 hours without a majority', async () => {
  ok(await h.modal(C, `trade:proposem:${A.id}`, { send: 'RB', get: 'TE', why: 'Depth' }));
  const tr = require('../src/services/trades');
  const t = tr.recent(1)[0];
  ok(await h.modal(A, `trade:acceptm:${t.id}`, { why: 'Upgrade' }));
  clock += 25 * 3600000;
  await scheduler.tradesAndClips(Date.now());
  assert.strictEqual(tr.get(t.id).status, 'approved');
});

test('frozen trades at 3 strikes', async () => {
  strikes.add(D.id, 'conduct', 'test');
  strikes.add(D.id, 'conduct', 'test');
  assert.ok(strikes.isFrozen(D.id));
  userErr(await h.modal(D, `trade:proposem:${C.id}`, { send: 'x', get: 'y', why: 'z' }), /frozen/);
});

test('clips: submit, accept, feature, milestones, Clip of the Week', async () => {
  const startA = credits.balance(A.id);
  ok(await h.cmd(A, 'clip', 'submit', { link: 'https://clips.twitch.tv/abc', type: 'Clutch', vertical: true }));
  ok(await h.cmd(B, 'clip', 'submit', { link: 'https://youtube.com/shorts/xyz', type: 'Reaction' }));
  const clipsSvc = require('../src/services/clips');
  const [cb, ca] = clipsSvc.pending().slice(-2).reverse();
  userErr(await h.button(A, `clip:accept:${ca.id}`), /clip team/);
  ok(await h.button(ADMIN, `clip:accept:${ca.id}`));
  assert.strictEqual(credits.balance(A.id), startA + 10, 'accepted + vertical');
  ok(await h.button(ADMIN, `clip:feature:${ca.id}`));
  assert.strictEqual(credits.balance(A.id), startA + 30);
  ok(await h.cmd(ADMIN, 'hq', 'clip-views', { clip: ca.id, milestone: '10k' }));
  assert.strictEqual(credits.balance(A.id), startA + 70, '1K + 10K paid');
  ok(await h.button(ADMIN, `clip:accept:${cb.id}`));
  ok(await h.cmd(ADMIN, 'hq', 'clip-finalists', { clips: `${ca.id}, ${cb.id}` }));
  const poll = clipsSvc.openPolls()[0];
  userErr(await h.button(A, `cotw:vote:${poll.id}:${ca.id}`), /own clip/);
  ok(await h.button(B, `cotw:vote:${poll.id}:${ca.id}`));
  ok(await h.button(V, `cotw:vote:${poll.id}:${ca.id}`));
  ok(await h.cmd(ADMIN, 'hq', 'clip-crown'));
  assert.strictEqual(credits.balance(A.id), startA + 120);
  assert.ok(h.memberRoles.get(A.id).has(settings.roleId('highlight')));
});

test('academy is paywalled, then levels up', async () => {
  userErr(await h.cmd(A, 'academy', 'progress'), /Standard and Pro/);
  A.roles = [settings.roleId('standard')];
  ok(await h.cmd(A, 'academy', 'progress'));
  ok(await h.modal(A, 'acad:submitm', { proof: 'https://twitch.tv/videos/1', notes: '' }));
  const sub = require('../src/services/academy').pending()[0];
  const bal = credits.balance(A.id);
  ok(await h.button(ADMIN, `acad:approve:${sub.id}`));
  assert.strictEqual(members.get(A.id).academy_level, 1);
  assert.strictEqual(credits.balance(A.id), bal + 25);
});

test('shop: redeem, refund', async () => {
  const shop = require('../src/services/shop');
  const item = shop.items()[0];
  userErr(await h.cmd(C, 'shop', 'redeem', { item: item.id }), /more credits/);
  ok(await h.cmd(ADMIN, 'bank', 'give', { member: C.id, amount: 500, reason: 'test' }));
  const bal = credits.balance(C.id);
  ok(await h.cmd(C, 'shop', 'redeem', { item: item.id }));
  assert.strictEqual(credits.balance(C.id), bal - item.cost);
  const red = shop.openRedemptions()[0];
  ok(await h.button(ADMIN, `redeem:refund:${red.id}`));
  assert.strictEqual(credits.balance(C.id), bal);
});

test('in the stands and passport', async () => {
  const bal = credits.balance(B.id);
  ok(await h.modal(B, `stands:scoutm:${A.id}`, { off: 'Gun bunch', def: 'Cover 3', key: 'Runs on 3rd', vod: '' }));
  assert.strictEqual(credits.balance(B.id), bal + 10);
  const raid = ok(await h.cmd(B, 'stands', 'raid', { target: A.id }));
  const cid = (JSON.stringify(raid.responses[0].body).match(/raid:ok:[0-9:]+/) || [])[0];
  userErr(await h.button(C, cid), /Only the streamer/);
  ok(await h.button(A, cid));
  assert.strictEqual(credits.balance(B.id), bal + 17, 'raid pays the /setup value (7)');
  ok(await h.cmd(A, 'stands', 'chat', { member1: B.id, member2: A.id, member3: V.id }));

  const code = require('../src/services/stands').newCode(A.id).code;
  userErr(await h.cmd(A, 'passport', 'stamp', { code }), /own code/);
  const s = ok(await h.cmd(V, 'passport', 'stamp', { code: code.toLowerCase() }));
  assert.match(s.text, /Stamped/);
  userErr(await h.cmd(V, 'passport', 'stamp', { code }), /already stamped/);
  const codeB = require('../src/services/stands').newCode(B.id).code;
  ok(await h.cmd(V, 'passport', 'stamp', { code: codeB }));
  assert.ok(h.memberRoles.get(V.id).has(settings.roleId('fan')), 'Fan role at 5 points');
  ok(await h.cmd(ADMIN, 'hq', 'passport-draw'));
});

test('profile, score, boards, dashboard, backup, awards', async () => {
  const p = ok(await h.cmd(A, 'profile'));
  assert.match(p.text, /OVR CREATOR/);
  ok(await h.cmd(ADMIN, 'hq', 'score-rate', { member: A.id, category: 'presentation', value: 90 }));
  assert.strictEqual(require('../src/services/score').compute(A.id).categories.presentation.value, 90);
  ok(await h.cmd(A, 'score', 'leaderboard'));
  ok(await h.cmd(A, 'credits', 'balance'));
  ok(await h.cmd(A, 'credits', 'leaderboard', { period: 'all' }));
  ok(await h.cmd(A, 'credits', 'earn'));
  ok(await h.cmd(A, 'matchups'));
  ok(await h.cmd(A, 'draftrace'));
  ok(await h.cmd(A, 'help'));
  ok(await h.cmd(ADMIN, 'hq', 'dashboard'));
  ok(await h.cmd(ADMIN, 'hq', 'gotw-candidates'));
  ok(await h.cmd(ADMIN, 'hq', 'post', { what: 'board' }));
  const bk = ok(await h.cmd(ADMIN, 'hq', 'backup'));
  const withFiles = bk.calls.find((c) => c.files && c.files.length);
  assert.ok(withFiles && withFiles.files.length === 4, 'db + 3 CSVs');
  assert.ok(withFiles.files[0].data.length > 1000);

  ok(await h.cmd(ADMIN, 'hq', 'awards-open'));
  userErr(await h.cmd(A, 'awards', 'vote', { category: 'MVP', nominee: A.id }), /yourself/);
  ok(await h.cmd(B, 'awards', 'vote', { category: 'MVP', nominee: A.id }));
  const res = ok(await h.cmd(ADMIN, 'hq', 'awards-close', { announce: true }));
  assert.match(res.text, /MVP/);
});

test('scheduler daily posts and credit log', async () => {
  at('2026-11-22T19:30:00-08:00'); // Sunday evening
  await scheduler.tick();
  await notify.flushCredits();
  assert.ok(h.posts(settings.channelId('creditLog')).length >= 1, 'credit log batched');
  assert.ok(h.posts(settings.channelId('reliability')).length >= 1, 'reliability board posted');
  assert.ok(h.posts(settings.channelId('mediaDesk')).length >= 1, 'media brief posted');
});

test('no unexpected errors anywhere', () => {
  assert.deepStrictEqual(h.errors.map((e) => `${e.where}: ${e.error && e.error.message}`), []);
});

test.after(() => { Date.now = realNow; });

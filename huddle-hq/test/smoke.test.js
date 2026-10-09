'use strict';
// Fires every remaining command/subcommand once and checks none of them crash.
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./harness');

const realNow = Date.now;
let clock = Date.parse('2026-11-13T12:00:00-08:00');
Date.now = () => clock;

const h = setup();
require('../src/notify').attach();
const settings = require('../src/settings');
const games = require('../src/services/games');
const strikes = require('../src/services/strikes');
const league = require('../src/services/league');

const ADMIN = { id: '700000000000000001', name: 'admin', perms: '8' };
const A = { id: '700000000000000101', name: 'a' };
const B = { id: '700000000000000102', name: 'b' };
const C = { id: '700000000000000103', name: 'c' };
const D = { id: '700000000000000104', name: 'd' };

const crashed = (r) => /Something went wrong/.test(r.all);
async function run(label, p) {
  const r = await p;
  assert.ok(!crashed(r), `${label} crashed: ${r.all.slice(0, 300)}`);
  return r;
}

test('every command runs without crashing', async () => {
  await run('setup auto', h.cmd(ADMIN, 'setup', 'auto'));
  await run('setup status', h.cmd(ADMIN, 'setup', 'status'));
  await run('setup channel', h.cmd(ADMIN, 'setup', 'channel', { purpose: 'wire', channel: '700000000000009999' }));
  await run('setup role', h.cmd(ADMIN, 'setup', 'role', { purpose: 'pro', role: '700000000000008888' }));
  await run('setup limit', h.cmd(ADMIN, 'setup', 'limit', { rule: 'clipsPerWeek', value: 6 }));
  assert.strictEqual(settings.limit('clipsPerWeek'), 6);
  await run('setup link', h.cmd(ADMIN, 'setup', 'link', { whop: 'https://whop.com/thn', logo: 'https://example.com/logo.png' }));
  const nonAdmin = await h.cmd(A, 'setup', 'status');
  assert.match(nonAdmin.text, /Only the Commissioner/);

  const join = await run('join', h.cmd(A, 'join'));
  assert.ok(join.responses.some((c) => c.body && c.body.type === 9), 'join opens a modal');
  for (const [u, n] of [[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D']]) {
    await run('join submit', h.modal(u, 'join:submit', { name: n, url: `twitch.tv/${n}x`, tag: 'tag', tz: 'PT', avail: 'any' }));
  }
  await run('availability', h.cmd(A, 'availability'));
  await run('stream', h.cmd(A, 'stream', { link: 'twitch.tv/newname' }));
  await run('help', h.cmd(A, 'help'));
  await run('waitlist', h.button(ADMIN, `app:waitlist:${D.id}`));
  await run('decline', h.button(ADMIN, `app:decline:${D.id}`));

  for (const [u, team] of [[A, 'Raiders'], [B, 'Chiefs'], [C, 'Bills'], [D, 'Dolphins']]) {
    await run('team-assign', h.cmd(ADMIN, 'commish', 'team-assign', { member: u.id, team, league: 'HL' }));
  }
  await run('teams', h.cmd(ADMIN, 'commish', 'teams', { league: 'HL' }));
  await run('activate', h.cmd(ADMIN, 'commish', 'activate', { league: 'NL', on: true }));
  assert.deepStrictEqual(settings.activeLeagues(), ['HL', 'NL']);
  await run('activate off', h.cmd(ADMIN, 'commish', 'activate', { league: 'NL', on: false }));
  await run('import', h.modal(ADMIN, 'league:schedm:HL:1', { lines: 'Raiders @ Chiefs\nBills @ Dolphins' }));
  await run('clear', h.cmd(ADMIN, 'commish', 'schedule-clear', { league: 'HL', week: 1 }));
  assert.strictEqual(games.weekGames('HL', 1).length, 0);
  await run('import again', h.modal(ADMIN, 'league:schedm:HL:1', { lines: 'Raiders @ Chiefs\nBills @ Dolphins' }));
  await run('advance', h.cmd(ADMIN, 'commish', 'advance', { which: 'HL' }));
  await run('repost', h.cmd(ADMIN, 'commish', 'repost', { league: 'HL' }));
  await run('advance-set', h.cmd(ADMIN, 'commish', 'advance-set', { day: 'mon', time: '8 PM' }));
  await run('advance-delay', h.cmd(ADMIN, 'commish', 'advance-delay'));
  await run('deadline', h.cmd(ADMIN, 'commish', 'deadline', { league: 'HL', week: 8 }));
  await run('eliminate', h.cmd(ADMIN, 'commish', 'eliminate', { league: 'HL', team: 'Dolphins' }));
  await run('draftrace', h.cmd(A, 'draftrace'));
  await run('matchups', h.cmd(A, 'matchups', { league: 'HL', week: 1 }));
  await run('tonight', h.cmd(A, 'tonight'));
  await run('autocomplete team', h.cmd(ADMIN, 'commish', 'team-assign', {}, {}).catch(() => ({ all: '' })));

  const g = games.weekGames('HL', 1).find((x) => x.away_team === 'Raiders').id;
  const g2 = games.weekGames('HL', 1).find((x) => x.away_team === 'Bills').id;
  await run('game suggest', h.cmd(A, 'game', 'suggest'));
  await run('game info', h.cmd(A, 'game', 'info'));
  await run('custom button', h.button(A, `game:custom:${g}`));
  await run('ruling settime', h.cmd(ADMIN, 'ruling', 'settime', { game: g, day: 'sat', time: '6 PM', timezone: 'PT' }));
  clock = Date.parse('2026-11-14T17:50:00-08:00');
  await run('live button', h.button(A, `game:live:${g}`));
  await run('kickoff button', h.button(B, `game:kickoff:${g}`));
  await run('final cmd', h.cmd(A, 'game', 'final', { my_score: 10, opp_score: 7 }));
  await run('dispute', h.button(B, `game:dispute:${g}`));
  await run('ruling final', h.cmd(ADMIN, 'ruling', 'final', { game: g, away_score: 10, home_score: 14 }));
  assert.strictEqual(games.getGame(g).winner, 'home');
  await run('vod cmd', h.cmd(A, 'game', 'vod', { link: 'https://twitch.tv/videos/9' }, { channel: games.getGame(g).thread_id, channelType: 11 }));
  await run('ruling verify', h.cmd(ADMIN, 'ruling', 'verify', { game: g, member: A.id }));
  await run('ruling reopen', h.cmd(ADMIN, 'ruling', 'reopen', { game: g }));
  await run('ruling ragequit', h.cmd(ADMIN, 'ruling', 'ragequit', { game: g, member: B.id }));
  assert.strictEqual(games.getGame(g).status, 'forfeit');
  assert.strictEqual(strikes.count(B.id, settings.season(), 'ragequit'), 1);
  await run('ruling forcewin', h.cmd(ADMIN, 'ruling', 'forcewin', { game: g2, winner: C.id, strike: false }));
  assert.strictEqual(strikes.count(D.id), 0);
  const dc = await run('dc', h.cmd(A, 'game', 'dc', { screenshot: 'att1', note: 'Q3 5:00' }, { resolved: { attachments: { att1: { url: 'https://cdn.discordapp.com/x.png' } } } }));
  assert.ok(dc);

  await run('strike add', h.cmd(ADMIN, 'strike', 'add', { member: C.id, kind: 'conduct', reason: 'trash talk over the line' }));
  const s = strikes.list(C.id)[0];
  await run('strike list', h.cmd(ADMIN, 'strike', 'list', { member: C.id }));
  await run('strike void', h.cmd(ADMIN, 'strike', 'void', { id: s.id }));
  assert.strictEqual(strikes.count(C.id), 0);
  await run('unfreeze', h.cmd(ADMIN, 'commish', 'unfreeze', { member: B.id }));

  await run('bank item-add', h.cmd(ADMIN, 'bank', 'item-add', { name: 'Shoutout', cost: 50, description: 'On the show' }));
  await run('bank item-edit', h.cmd(ADMIN, 'bank', 'item-edit', { item: 1, cost: 175, active: true }));
  await run('bank take', h.cmd(ADMIN, 'bank', 'take', { member: A.id, amount: 1, reason: 'fix' }));
  await run('bank redemptions', h.cmd(ADMIN, 'bank', 'redemptions'));
  await run('shop view', h.cmd(A, 'shop', 'view'));
  await run('credits balance other', h.cmd(A, 'credits', 'balance', { member: B.id }));

  await run('tradedesk mine', h.cmd(A, 'tradedesk', 'mine'));
  const tp = await run('tradedesk propose', h.cmd(A, 'tradedesk', 'propose', { partner: B.id }));
  assert.ok(tp.responses.some((c) => c.body && c.body.type === 9));
  await run('trade modal', h.modal(A, `trade:proposem:${B.id}`, { send: 'x', get: 'y', why: 'z' }));
  const tid = require('../src/services/trades').recent(1)[0].id;
  await run('trade decline', h.button(B, `trade:decline:${tid}`));
  await run('trade grade', h.cmd(ADMIN, 'tradedesk', 'grade', { id: tid, team: 'from', grade: 'B+' }));

  await run('clip submit', h.cmd(A, 'clip', 'submit', { link: 'https://x.com/clip', type: 'Blooper' }));
  await run('clip mine', h.cmd(A, 'clip', 'mine'));
  await run('academy setrole', h.cmd(ADMIN, 'academy', 'setrole', { level: 1, role: '700000000000007777' }));

  await run('score card', h.cmd(A, 'score', 'card', { member: B.id }));
  await run('score explain', h.cmd(A, 'score', 'explain'));
  await run('passport code', h.cmd(A, 'passport', 'code'));
  await run('passport card', h.cmd(B, 'passport', 'card'));
  await run('awards ballot', h.cmd(A, 'awards', 'ballot'));
  const closed = await h.cmd(B, 'awards', 'vote', { category: 'MVP', nominee: A.id });
  assert.match(closed.text, /isn't open/);

  await run('gotw-set', h.cmd(ADMIN, 'hq', 'gotw-set', { game: g2 }));
  const ev = await run('event-open', h.cmd(ADMIN, 'hq', 'event-open', { name: 'Draft Night', minutes: 30 }));
  const eid = (JSON.stringify(ev.responses[0].body).match(/event:here:(\d+)/) || [])[1];
  await run('event here', h.button(A, `event:here:${eid}`));
  await run('event here again', h.button(A, `event:here:${eid}`));
  await run('reviews', h.cmd(ADMIN, 'hq', 'reviews'));
  await run('post tonight', h.cmd(ADMIN, 'hq', 'post', { what: 'media' }).then((r) => r));

  await run('champions', h.cmd(ADMIN, 'commish', 'champions', { league: 'HL', champion: A.id, runner_up: B.id }));
  await run('season-review', h.cmd(ADMIN, 'commish', 'season-review'));
  await run('season-apply', h.cmd(ADMIN, 'commish', 'season-apply'));
  const require_ = require('../src/services/members');
  assert.strictEqual(require_.get(A.id).league, 'NL', 'champion promoted');
  assert.deepStrictEqual(settings.activeLeagues(), ['HL', 'NL']);
  await run('move', h.cmd(ADMIN, 'commish', 'move', { member: A.id, league: 'HL' }));
  await run('remove-member', h.cmd(ADMIN, 'commish', 'remove-member', { member: D.id, alumni: true }));
  await run('setup credit', h.cmd(ADMIN, 'setup', 'credit', { rule: 'unusedAudible', value: 10 }));
  await run('season-start', h.cmd(ADMIN, 'commish', 'season-start', { number: 2 }));
  assert.strictEqual(settings.season(), 2);
  assert.ok(league.leaguesInUse().length >= 1);

  assert.deepStrictEqual(h.errors.map((e) => `${e.where}: ${e.error && e.error.message}`), []);
});

test('autocomplete handlers answer', async () => {
  const router = require('../src/discord/router');
  const before = h.calls.length;
  await router.handle({
    id: '1', token: 't', type: 4, guild_id: h.GUILD, channel_id: '1', member: { user: { id: ADMIN.id }, roles: [], permissions: '8' },
    data: { name: 'ruling', options: [{ type: 1, name: 'sim', options: [{ name: 'game', type: 4, value: '', focused: true }] }] },
  }, { guildId: h.GUILD });
  await router.handle({
    id: '2', token: 't2', type: 4, guild_id: h.GUILD, channel_id: '1', member: { user: { id: ADMIN.id }, roles: [], permissions: '8' },
    data: { name: 'commish', options: [{ type: 1, name: 'team-assign', options: [{ name: 'team', type: 3, value: 'pack', focused: true }] }] },
  }, { guildId: h.GUILD });
  const answers = h.calls.slice(before).filter((c) => c.body && c.body.type === 8);
  assert.strictEqual(answers.length, 2);
  assert.ok(Array.isArray(answers[0].body.data.choices), 'game list (empty: season 2 just started)');
  assert.strictEqual(answers[1].body.data.choices[0].value, 'Packers');
});

test.after(() => { Date.now = realNow; });

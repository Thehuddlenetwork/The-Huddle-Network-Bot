'use strict';
// A fake Discord: records every REST call and lets tests fire interactions through the real router.
const db = require('../src/db');

const GUILD = '900000000000000001';
let seq = 1000;
const snow = () => String(910000000000000000n + BigInt(seq++));

function setup() {
  db.init(':memory:');
  require('../src/services/shop').seed();
  const api = require('../src/discord/api');
  const router = require('../src/discord/router');
  const { bus } = require('../src/bus');
  const calls = [];
  const memberRoles = new Map(); // userId -> Set(roleId)
  const rest = {
    async request(method, path, opts = {}) {
      const call = { method, path, body: opts.body, files: opts.files };
      calls.push(call);
      let m;
      if (method === 'POST' && (m = path.match(/^\/channels\/(\d+)\/messages$/))) return { id: snow(), channel_id: m[1], ...opts.body };
      if (method === 'PATCH' && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) return { id: m[2], channel_id: m[1] };
      if (method === 'POST' && /\/threads$/.test(path)) return { id: snow(), type: 11 };
      if (method === 'POST' && path === '/users/@me/channels') return { id: snow() };
      if (method === 'PUT' && (m = path.match(/members\/(\d+)\/roles\/(\d+)$/))) { if (!memberRoles.has(m[1])) memberRoles.set(m[1], new Set()); memberRoles.get(m[1]).add(m[2]); return null; }
      if (method === 'DELETE' && (m = path.match(/members\/(\d+)\/roles\/(\d+)$/))) { if (memberRoles.has(m[1])) memberRoles.get(m[1]).delete(m[2]); return null; }
      if (method === 'GET' && (m = path.match(/members\/(\d+)$/))) return { user: { id: m[1] }, roles: [...(memberRoles.get(m[1]) || [])] };
      if (method === 'GET' && /\/roles$/.test(path)) return [];
      if (method === 'GET' && /\/channels$/.test(path)) return [];
      if (method === 'POST' && /\/roles$/.test(path)) return { id: snow(), name: opts.body.name };
      if (method === 'POST' && /\/guilds\/\d+\/channels$/.test(path)) return { id: snow(), name: opts.body.name, type: opts.body.type };
      if (method === 'PUT' && /\/commands$/.test(path)) return opts.body;
      if (/\/interactions\//.test(path)) return null;
      if (/\/webhooks\//.test(path)) return { id: snow() };
      return null;
    },
  };
  api.configure({ rest, guildId: GUILD });
  api.setIdentity({ appId: '900000000000000002', botId: '900000000000000003' });
  for (const n of ['setup', 'members', 'games', 'league', 'economy', 'trades', 'clips', 'academy', 'network']) router.register(require(`../src/modules/${n}`));
  const errors = [];
  bus.on('error', (e) => errors.push(e));

  const base = (user, extra = {}) => ({
    id: snow(), token: `tok${seq}`, guild_id: GUILD, channel_id: extra.channel || '900000000000000050',
    channel: { id: extra.channel || '900000000000000050', type: extra.channelType || 0 },
    member: { user: { id: user.id, username: user.name }, roles: user.roles || [], permissions: user.perms || '0' },
  });

  const optList = (options) => Object.entries(options).filter(([, v]) => v !== undefined).map(([name, value]) => ({ name, type: typeof value === 'number' ? 4 : typeof value === 'boolean' ? 5 : 3, value }));

  async function fire(raw) {
    const start = calls.length;
    await router.handle(raw, { guildId: GUILD });
    const mine = calls.slice(start);
    const responses = mine.filter((c) => c.path.includes(raw.id) || c.path.includes(raw.token));
    return { raw, calls: mine, responses, text: JSON.stringify(responses.map((r) => r.body)), all: JSON.stringify(mine.map((r) => r.body)) };
  }

  const h = {
    GUILD, calls, errors, memberRoles, snow,
    cmd: (user, name, sub, options = {}, extra = {}) => fire({
      ...base(user, extra), type: 2,
      data: { name, options: sub ? [{ type: 1, name: sub, options: optList(options) }] : optList(options), resolved: extra.resolved || {} },
    }),
    button: (user, customId, extra = {}) => fire({ ...base(user, extra), type: 3, data: { custom_id: customId, component_type: 2 }, message: { id: extra.messageId || snow(), embeds: [] } }),
    select: (user, customId, values, extra = {}) => fire({ ...base(user, extra), type: 3, data: { custom_id: customId, component_type: 3, values }, message: { id: snow(), embeds: [] } }),
    modal: (user, customId, fields, extra = {}) => fire({
      ...base(user, extra), type: 5,
      data: { custom_id: customId, components: Object.entries(fields).map(([k, v]) => ({ type: 1, components: [{ type: 4, custom_id: k, value: v }] })) },
    }),
    posts: (channelId) => calls.filter((c) => c.method === 'POST' && c.path === `/channels/${channelId}/messages`),
  };
  return h;
}

module.exports = { setup };

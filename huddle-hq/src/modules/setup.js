'use strict';
// /setup: wire the bot to the server's channels and roles, and tune values.
const settings = require('../settings');
const api = require('../discord/api');
const b = require('../discord/builders');
const ui = require('../lib/ui');
const { UserError } = require('../bus');
const { CHANNELS, ROLES, CREDITS, LIMITS, BRAND } = require('../constants');

const VIEW = 1024n;
const SEND = 2048n;
const READ_HISTORY = 65536n;
const THREADS_SEND = 274877906944n;
const EMBED = 16384n;
const ATTACH = 32768n;
const MANAGE_THREADS = 17179869184n;
const CREATE_PUBLIC_THREADS = 34359738368n;
const USE_COMMANDS = 2147483648n;
const ALLOW_MEMBER = VIEW | READ_HISTORY | THREADS_SEND | USE_COMMANDS;
const ALLOW_BOT = VIEW | SEND | READ_HISTORY | THREADS_SEND | EMBED | ATTACH | MANAGE_THREADS | CREATE_PUBLIC_THREADS;

// Bot-only posting channels: members read and use buttons, but don't chat.
const READ_ONLY = new Set(['wire', 'tonight', 'goLive', 'join', 'clipVote', 'advance', 'reliability', 'creditLog', 'gamesHL', 'gamesNL', 'tradeDesk', 'academy', 'scouting']);

function overwrites(purpose, roleIds, guildId) {
  const def = CHANNELS[purpose];
  const list = [];
  const botId = api.botId();
  const everyoneDeny = def.access === 'public' ? (READ_ONLY.has(purpose) ? SEND : 0n) : VIEW;
  if (everyoneDeny) list.push({ id: guildId, type: 0, deny: String(everyoneDeny), allow: '0' });
  const allow = (rid) => rid && list.push({ id: rid, type: 0, allow: String(ALLOW_MEMBER), deny: READ_ONLY.has(purpose) ? String(SEND) : '0' });
  if (def.access === 'members') allow(roleIds.member);
  if (def.access !== 'public') {
    for (const p of ['commissioner', 'staff', ...(def.extraRoles || [])]) {
      if (roleIds[p]) list.push({ id: roleIds[p], type: 0, allow: String(ALLOW_MEMBER | SEND), deny: '0' });
    }
  }
  if (botId) list.push({ id: botId, type: 1, allow: String(ALLOW_BOT), deny: '0' });
  return list;
}

async function autoSetup() {
  const guildId = api.guildId();
  const report = { rolesFound: [], rolesMade: [], chFound: [], chMade: [], failed: [] };
  const roles = await api.getRoles();
  const roleIds = {};
  for (const [purpose, def] of Object.entries(ROLES)) {
    let id = settings.roleId(purpose);
    if (id && !roles.find((r) => r.id === id)) id = null;
    if (!id) {
      const found = roles.find((r) => r.name.toLowerCase() === def.name.toLowerCase());
      if (found) { id = found.id; report.rolesFound.push(def.name); } else {
        try {
          const made = await api.createRole({ name: def.name, color: def.color || 0, hoist: !!def.hoist, mentionable: ['committee', 'clipTeam', 'coach', 'media'].includes(purpose) });
          id = made.id; report.rolesMade.push(def.name);
        } catch (e) { report.failed.push(`role ${def.name}: ${e.message}`); }
      }
      if (id) settings.set(`role:${purpose}`, id);
    }
    roleIds[purpose] = id;
  }

  const channels = await api.getChannels();
  let category = channels.find((c) => c.type === 4 && c.name.toLowerCase() === 'huddle hq');
  for (const [purpose, def] of Object.entries(CHANNELS)) {
    let id = settings.channelId(purpose);
    if (id && !channels.find((c) => c.id === id)) id = null;
    if (id) continue;
    const found = channels.find((c) => c.type === 0 && c.name === def.name);
    if (found) { settings.set(`channel:${purpose}`, found.id); report.chFound.push(`#${def.name}`); continue; }
    try {
      if (!category) category = await api.createChannel({ name: 'HUDDLE HQ', type: 4 });
      const made = await api.createChannel({ name: def.name, type: 0, parent_id: category.id, topic: def.label, permission_overwrites: overwrites(purpose, roleIds, guildId) });
      settings.set(`channel:${purpose}`, made.id);
      report.chMade.push(`#${def.name}`);
    } catch (e) { report.failed.push(`#${def.name}: ${e.message}`); }
  }
  return report;
}

function statusEmbed() {
  const ch = Object.entries(CHANNELS).map(([p, d]) => `${settings.channelId(p) ? `✅ <#${settings.channelId(p)}>` : `❌ ${d.name}`} · ${d.label}`);
  const rl = Object.entries(ROLES).map(([p, d]) => `${settings.roleId(p) ? `✅ <@&${settings.roleId(p)}>` : `❌ ${d.name}`}`);
  return [
    ui.embed({ title: 'SETUP  |  CHANNELS', description: ch.join('\n'), color: BRAND.black }),
    ui.embed({
      title: 'SETUP  |  ROLES AND LINKS',
      description: `${rl.join('  ')}\n\n**Whop link:** ${settings.get('whop_url') || 'not set'}\n**Logo:** ${settings.get('logo_url') ? 'set' : 'not set'}\n**Leagues on:** ${settings.activeLeagues().join(', ')}\n**Season:** ${settings.season()}`,
      color: BRAND.black,
    }),
  ];
}

function joinPanel() {
  return {
    embeds: [ui.embed({
      title: 'JOIN THE HUDDLE NETWORK',
      description: [
        'A Madden franchise built only for streamers, run like a broadcast network.',
        '',
        '🏈 **Every game broadcast.** Matching THN overlays, posted schedules, Game of the Week.',
        '🎓 **Content coaching.** The Huddle Academy turns your league games into channel growth.',
        '🎬 **Your clips on THN.** The best moments go up on THN socials with your name on them.',
        '🤝 **A real community.** Streamers who show up, play it out, and support each other.',
        '',
        'Open to any streamer or aspiring streamer. Tap the button and tell us about your channel.',
      ].join('\n'),
      color: BRAND.red,
    })],
    components: ui.rows([ui.button('join:open', 'Join THN', 'danger', { emoji: '🏈' })]),
  };
}

async function setupCommand(i) {
  if (!i.isAdmin && !i.hasRole('commissioner')) throw new UserError('Only the Commissioner or a server admin can run setup.');
  switch (i.sub) {
    case 'auto': {
      await i.defer(true);
      const r = await autoSetup();
      const lines = [];
      if (r.rolesMade.length) lines.push(`**Roles created:** ${r.rolesMade.join(', ')}`);
      if (r.rolesFound.length) lines.push(`**Roles linked:** ${r.rolesFound.join(', ')}`);
      if (r.chMade.length) lines.push(`**Channels created** (in HUDDLE HQ): ${r.chMade.join(', ')}`);
      if (r.chFound.length) lines.push(`**Channels linked:** ${r.chFound.join(', ')}`);
      if (r.failed.length) lines.push('', '**Couldn\'t do:**', ...r.failed.map((f) => `• ${f}`), '', 'Usually this means the bot\'s role needs Manage Roles and Manage Channels, and must sit above the roles it gives out (Server Settings → Roles, drag Huddle HQ up).');
      lines.push('', 'Next: `/setup panel` in your join channel, then `/setup link` for your Whop page. Map Whop\'s roles to Academy Standard / Academy Pro with `/setup role`.');
      return i.send({ embeds: [ui.ok(lines.join('\n') || 'Everything was already set up.', 'SETUP COMPLETE')] });
    }
    case 'channel': {
      settings.set(`channel:${i.str('purpose')}`, i.get('channel'));
      return i.reply({ embeds: [ui.ok(`${CHANNELS[i.str('purpose')].label} → <#${i.get('channel')}>`)], ephemeral: true });
    }
    case 'role': {
      settings.set(`role:${i.str('purpose')}`, i.get('role'));
      return i.reply({ embeds: [ui.ok(`${ROLES[i.str('purpose')].name} → <@&${i.get('role')}>`)], ephemeral: true });
    }
    case 'credit': {
      const key = i.str('rule');
      if (!CREDITS[key]) throw new UserError('Pick a rule from the list.');
      settings.set(`credit:${key}`, i.int('value'));
      return i.reply({ embeds: [ui.ok(`${CREDITS[key][1]}: now **${i.int('value')}** credits (default ${CREDITS[key][0]}).`)], ephemeral: true });
    }
    case 'limit': {
      const key = i.str('rule');
      if (!LIMITS[key]) throw new UserError('Pick a setting from the list.');
      settings.set(`limit:${key}`, i.int('value'));
      return i.reply({ embeds: [ui.ok(`${LIMITS[key][1]}: now **${i.int('value')}** (default ${LIMITS[key][0]}).`)], ephemeral: true });
    }
    case 'link': {
      if (i.str('whop')) settings.set('whop_url', i.str('whop'));
      if (i.str('logo')) { settings.set('logo_url', i.str('logo')); ui.setLogo(i.str('logo')); }
      return i.reply({ embeds: [ui.ok('Links saved.')], ephemeral: true });
    }
    case 'panel': {
      await api.send(i.channelId, joinPanel());
      return i.reply({ embeds: [ui.ok('Join panel posted.')], ephemeral: true });
    }
    case 'status': return i.reply({ embeds: statusEmbed(), ephemeral: true });
    default: throw new UserError('Unknown option.');
  }
}

async function ruleAutocomplete(i) {
  const f = i.focused();
  const q = String((f && f.value) || '').toLowerCase();
  const table = i.sub === 'credit' ? CREDITS : LIMITS;
  const getter = i.sub === 'credit' ? settings.credit : settings.limit;
  await i.autocomplete(Object.entries(table).filter(([k, v]) => `${k} ${v[1]}`.toLowerCase().includes(q))
    .map(([k, v]) => ({ name: `${v[1]} (now ${getter(k)})`, value: k })));
}

module.exports = {
  commands: [
    {
      def: b.command('setup', 'Admin: connect Huddle HQ to this server', [
        b.sub('auto', 'Create or link every channel and role the bot needs'),
        b.sub('status', 'What is connected and what is missing'),
        b.sub('channel', 'Point a bot feature at a channel', [
          b.str('purpose', 'Feature', { required: true, choices: Object.entries(CHANNELS).map(([value, d]) => ({ name: d.label.slice(0, 100), value })) }),
          b.channel('channel', 'Channel', { required: true, channelTypes: [0, 5] }),
        ]),
        b.sub('role', 'Point a bot role at a server role', [
          b.str('purpose', 'Bot role', { required: true, choices: Object.entries(ROLES).map(([value, d]) => ({ name: d.name, value })) }),
          b.role('role', 'Server role', { required: true }),
        ]),
        b.sub('credit', 'Change how many credits a rule pays', [b.str('rule', 'Rule', { required: true, autocomplete: true }), b.int('value', 'Credits', { required: true, min: 0, max: 10000 })]),
        b.sub('limit', 'Change a limit, cap or threshold', [b.str('rule', 'Setting', { required: true, autocomplete: true }), b.int('value', 'Value', { required: true, min: 0, max: 10000 })]),
        b.sub('link', 'Whop checkout link and logo image', [b.str('whop', 'Whop page for Standard / Pro', { max: 300 }), b.str('logo', 'Logo image URL (shows on bot posts)', { max: 300 })]),
        b.sub('panel', 'Post the Join THN panel in this channel'),
      ], 'admin'),
      run: setupCommand,
      autocomplete: ruleAutocomplete,
    },
  ],
  autoSetup,
  joinPanel,
};

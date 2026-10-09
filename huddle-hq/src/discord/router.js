'use strict';
const { Interaction, TYPE } = require('./interaction');
const { UserError, bus } = require('../bus');
const ui = require('../lib/ui');

const commands = new Map();
const components = new Map(); // "prefix:action" or "prefix" -> handler
const modals = new Map();

// A module exports { commands: [{ def, run, autocomplete }], buttons: {key: fn}, selects: {key: fn}, modals: {key: fn} }
function register(mod) {
  for (const c of mod.commands || []) commands.set(c.def.name, c);
  for (const [k, fn] of Object.entries(mod.buttons || {})) components.set(k, fn);
  for (const [k, fn] of Object.entries(mod.selects || {})) components.set(k, fn);
  for (const [k, fn] of Object.entries(mod.modals || {})) modals.set(k, fn);
}

const definitions = () => [...commands.values()].map((c) => c.def);

function lookup(map, args) {
  return map.get(`${args[0]}:${args[1]}`) || map.get(args[0]);
}

async function handle(raw, { guildId } = {}) {
  if (guildId && raw.guild_id && raw.guild_id !== guildId) return;
  const i = new Interaction(raw);
  try {
    if (!raw.guild_id) throw new UserError('Huddle HQ only works inside The Huddle Network server.');
    if (i.type === TYPE.COMMAND) {
      const c = commands.get(i.commandName);
      if (!c) throw new UserError('That command is no longer available.');
      await c.run(i);
    } else if (i.type === TYPE.AUTOCOMPLETE) {
      const c = commands.get(i.commandName);
      if (c && c.autocomplete) await c.autocomplete(i);
      else await i.autocomplete([]);
    } else if (i.type === TYPE.COMPONENT) {
      const fn = lookup(components, i.args);
      if (!fn) throw new UserError('This button has expired.');
      await fn(i);
    } else if (i.type === TYPE.MODAL) {
      const fn = lookup(modals, i.args);
      if (!fn) throw new UserError('This form has expired.');
      await fn(i);
    }
  } catch (e) {
    if (i.type === TYPE.AUTOCOMPLETE) { if (!i.acked) await i.autocomplete([]).catch(() => {}); return; }
    const friendly = e instanceof UserError;
    if (!friendly) {
      console.error(`[interaction] ${i.commandName || i.customId}:`, e);
      bus.emit('error', { where: i.commandName || i.customId, user: i.userId, error: e });
    }
    const msg = friendly ? e.message : 'Something went wrong on our end. Staff has been notified.';
    try { await i.send({ embeds: [ui.err(msg)], ephemeral: true }); } catch { /* interaction expired */ }
  }
}

module.exports = { register, definitions, handle, commands };

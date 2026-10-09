'use strict';
// Guild-scoped helpers over the REST client. One server, one bot.
const settings = require('../settings');

const state = { rest: null, guildId: null, appId: null, botId: null, dmChannels: new Map(), roleCache: null };

function configure({ rest, guildId }) {
  state.rest = rest;
  state.guildId = guildId;
}
function setIdentity({ appId, botId }) {
  state.appId = appId;
  state.botId = botId;
}
const rest = () => state.rest;
const guildId = () => state.guildId;
const appId = () => state.appId;
const botId = () => state.botId;

function normalize(payload, { forInteraction = false } = {}) {
  if (payload === null || payload === undefined) return {};
  if (typeof payload === 'string') payload = { content: payload };
  const out = {};
  if (payload.content !== undefined) out.content = String(payload.content).slice(0, 2000);
  if (payload.embeds) out.embeds = payload.embeds.slice(0, 10);
  if (payload.components) out.components = payload.components;
  if (forInteraction && payload.ephemeral) out.flags = (payload.flags || 0) | 64;
  else if (payload.flags) out.flags = payload.flags;
  out.allowed_mentions = payload.allowed_mentions || { parse: ['users'] };
  return out;
}

async function send(channelId, payload) {
  if (!channelId) return null;
  return state.rest.request('POST', `/channels/${channelId}/messages`, { body: normalize(payload), files: payload && payload.files });
}

async function edit(channelId, messageId, payload) {
  if (!channelId || !messageId) return null;
  return state.rest.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { body: normalize(payload) });
}

async function startThread(channelId, messageId, name) {
  return state.rest.request('POST', `/channels/${channelId}/messages/${messageId}/threads`, {
    body: { name: String(name).slice(0, 100), auto_archive_duration: 4320 },
  });
}

async function dm(userId, payload) {
  try {
    let ch = state.dmChannels.get(userId);
    if (!ch) {
      const c = await state.rest.request('POST', '/users/@me/channels', { body: { recipient_id: userId } });
      ch = c.id;
      state.dmChannels.set(userId, ch);
    }
    return await send(ch, payload);
  } catch {
    return null; // DMs closed — not an error worth surfacing
  }
}

async function getMember(userId) {
  try {
    return await state.rest.request('GET', `/guilds/${state.guildId}/members/${userId}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function addRole(userId, roleId, reason) {
  if (!roleId || !userId) return false;
  try {
    await state.rest.request('PUT', `/guilds/${state.guildId}/members/${userId}/roles/${roleId}`, { reason });
    return true;
  } catch (e) {
    console.warn(`[roles] could not add role ${roleId} to ${userId}: ${e.message}`);
    return false;
  }
}

async function removeRole(userId, roleId, reason) {
  if (!roleId || !userId) return false;
  try {
    await state.rest.request('DELETE', `/guilds/${state.guildId}/members/${userId}/roles/${roleId}`, { reason });
    return true;
  } catch (e) {
    console.warn(`[roles] could not remove role ${roleId} from ${userId}: ${e.message}`);
    return false;
  }
}

// Role by purpose (from /setup), e.g. addRoleFor(uid, 'member').
const addRoleFor = (userId, purpose, reason) => addRole(userId, settings.roleId(purpose), reason);
const removeRoleFor = (userId, purpose, reason) => removeRole(userId, settings.roleId(purpose), reason);

async function memberHasRole(userId, purpose) {
  const rid = settings.roleId(purpose);
  if (!rid) return false;
  const m = await getMember(userId);
  return !!(m && m.roles.includes(rid));
}

const getRoles = () => state.rest.request('GET', `/guilds/${state.guildId}/roles`);
const createRole = (body) => state.rest.request('POST', `/guilds/${state.guildId}/roles`, { body, reason: 'Huddle HQ setup' });
const getChannels = () => state.rest.request('GET', `/guilds/${state.guildId}/channels`);
const createChannel = (body) => state.rest.request('POST', `/guilds/${state.guildId}/channels`, { body, reason: 'Huddle HQ setup' });
const getGuild = () => state.rest.request('GET', `/guilds/${state.guildId}`);

async function registerCommands(commands) {
  return state.rest.request('PUT', `/applications/${state.appId}/guilds/${state.guildId}/commands`, { body: commands });
}

// Post to a channel by purpose. Never throws — a missing channel should not break a game flow.
async function post(purpose, payload) {
  const id = settings.channelId(purpose);
  if (!id) return null;
  try {
    return await send(id, payload);
  } catch (e) {
    console.warn(`[post] ${purpose}: ${e.message}`);
    return null;
  }
}

async function safeEdit(channelId, messageId, payload) {
  try { return await edit(channelId, messageId, payload); } catch (e) { console.warn(`[edit] ${e.message}`); return null; }
}

module.exports = {
  configure, setIdentity, rest, guildId, appId, botId, normalize, send, edit, safeEdit, startThread, dm,
  getMember, addRole, removeRole, addRoleFor, removeRoleFor, memberHasRole, getRoles, createRole,
  getChannels, createChannel, getGuild, registerCommands, post,
};

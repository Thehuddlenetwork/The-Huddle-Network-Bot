'use strict';
const api = require('./api');
const settings = require('../settings');

const TYPE = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL: 5 };
const ADMIN = 8n;
const MANAGE_GUILD = 32n;

function collectFields(components, out = {}) {
  for (const c of components || []) {
    if (c.custom_id && c.value !== undefined) out[c.custom_id] = c.value;
    if (c.custom_id && Array.isArray(c.values)) out[c.custom_id] = c.values;
    if (c.components) collectFields(c.components, out);
    if (c.component) collectFields([c.component], out);
  }
  return out;
}

class Interaction {
  constructor(raw) {
    this.raw = raw;
    this.id = raw.id;
    this.token = raw.token;
    this.type = raw.type;
    this.data = raw.data || {};
    this.guildId = raw.guild_id;
    this.channelId = raw.channel_id;
    this.channel = raw.channel || null;
    this.member = raw.member || null;
    this.user = (raw.member && raw.member.user) || raw.user || {};
    this.userId = this.user.id;
    this.message = raw.message || null;
    this.acked = false;
    this.deferred = false;
    this.replied = false;
    this.updateMode = false;

    this.group = null;
    this.sub = null;
    this.options = {};
    let opts = this.data.options || [];
    if (opts[0] && opts[0].type === 2) { this.group = opts[0].name; opts = opts[0].options || []; }
    if (opts[0] && opts[0].type === 1) { this.sub = opts[0].name; opts = opts[0].options || []; }
    for (const o of opts) this.options[o.name] = o;
    this.resolved = this.data.resolved || {};

    this.customId = this.data.custom_id || '';
    this.args = this.customId.split(':');
    this.values = this.data.values || [];
    this.fields = this.type === TYPE.MODAL ? collectFields(this.data.components) : {};
  }

  get commandName() { return this.data.name; }
  get roles() { return (this.member && this.member.roles) || []; }
  get perms() { try { return BigInt((this.member && this.member.permissions) || 0); } catch { return 0n; } }
  get isAdmin() { return (this.perms & ADMIN) === ADMIN || (this.perms & MANAGE_GUILD) === MANAGE_GUILD; }
  get displayName() { return (this.member && this.member.nick) || this.user.global_name || this.user.username || 'Member'; }
  get threadParentId() { return this.channel && this.channel.parent_id; }

  hasRole(purpose) {
    const id = settings.roleId(purpose);
    return !!id && this.roles.includes(id);
  }
  get isStaff() { return this.isAdmin || this.hasRole('commissioner') || this.hasRole('staff'); }
  isStaffOr(...purposes) { return this.isStaff || purposes.some((p) => this.hasRole(p)); }

  get(name) { return this.options[name] ? this.options[name].value : null; }
  str(name) { const v = this.get(name); return v === null ? null : String(v).trim(); }
  int(name) { const v = this.get(name); return v === null ? null : Number(v); }
  bool(name) { const v = this.get(name); return v === null ? null : !!v; }
  userId_(name) { return this.get(name); }
  attachment(name) { const id = this.get(name); return id && this.resolved.attachments ? this.resolved.attachments[id] : null; }
  focused() { return Object.values(this.options).find((o) => o.focused) || null; }
  field(id) { const v = this.fields[id]; return typeof v === 'string' ? v.trim() : v; }

  async callback(type, data) {
    await api.rest().request('POST', `/interactions/${this.id}/${this.token}/callback`, {
      body: data === undefined ? { type } : { type, data }, auth: false,
    });
    this.acked = true;
  }

  async reply(payload) {
    await this.callback(4, api.normalize(payload, { forInteraction: true }));
    this.replied = true;
  }
  async defer(ephemeral = true) {
    await this.callback(5, ephemeral ? { flags: 64 } : {});
    this.deferred = true;
  }
  async deferUpdate() {
    await this.callback(6);
    this.deferred = true;
    this.updateMode = true;
  }
  async update(payload) {
    const body = api.normalize(payload);
    delete body.flags;
    await this.callback(7, body);
    this.replied = true;
    this.updateMode = true;
  }
  async showModal(modal) { await this.callback(9, modal); }
  async autocomplete(choices) {
    await this.callback(8, { choices: (choices || []).slice(0, 25).map((c) => ({ name: String(c.name).slice(0, 100), value: c.value })) });
  }

  async editReply(payload) {
    const body = api.normalize(payload, { forInteraction: true });
    delete body.flags;
    return api.rest().request('PATCH', `/webhooks/${api.appId()}/${this.token}/messages/@original`, { body, files: payload && payload.files });
  }
  async followUp(payload) {
    return api.rest().request('POST', `/webhooks/${api.appId()}/${this.token}`, {
      body: api.normalize(payload, { forInteraction: true }), files: payload && payload.files,
    });
  }

  // Reply in whatever way is valid right now.
  async send(payload) {
    if (!this.acked) return this.reply(payload);
    if (this.deferred && !this.replied && !this.updateMode) { this.replied = true; return this.editReply(payload); }
    return this.followUp(payload);
  }
}

module.exports = { Interaction, TYPE };

'use strict';
// Discord gateway connection: identify, heartbeat, resume, reconnect.
const { EventEmitter } = require('events');

const INTENTS = { GUILDS: 1 << 0, GUILD_MEMBERS: 1 << 1, GUILD_PRESENCES: 1 << 8 };
const FATAL = new Set([4004, 4010, 4011, 4012, 4013]);

class Gateway extends EventEmitter {
  constructor({ token, intents, rest, WebSocketImpl }) {
    super();
    this.token = token;
    this.intents = intents;
    this.rest = rest;
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.ws = null;
    this.hbTimer = null;
    this.acked = true;
    this.backoff = 1000;
    this.stopped = false;
  }

  async connect() {
    const info = await this.rest.request('GET', '/gateway/bot');
    this.baseUrl = info.url;
    this.open(this.baseUrl);
  }

  open(url) {
    const ws = new this.WS(`${url}/?v=10&encoding=json`);
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let packet;
      try { packet = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      this.onPacket(packet);
    });
    ws.addEventListener('close', (ev) => { if (this.ws === ws) this.onClose(ev.code); });
    ws.addEventListener('error', () => { /* close follows */ });
  }

  send(op, d) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op, d }));
  }

  onPacket(p) {
    if (p.s !== null && p.s !== undefined) this.seq = p.s;
    switch (p.op) {
      case 10: { // HELLO
        const interval = p.d.heartbeat_interval;
        clearInterval(this.hbTimer);
        this.acked = true;
        setTimeout(() => this.beat(), Math.floor(interval * Math.random()));
        this.hbTimer = setInterval(() => this.beat(), interval);
        if (this.sessionId && this.seq !== null) {
          this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
        } else {
          this.send(2, {
            token: this.token,
            intents: this.intents,
            properties: { os: 'linux', browser: 'huddle-hq', device: 'huddle-hq' },
            presence: { status: 'online', since: null, afk: false, activities: [{ name: 'THE HUDDLE NETWORK', type: 3 }] },
          });
        }
        break;
      }
      case 11: this.acked = true; break;
      case 1: this.send(1, this.seq); break;
      case 7: this.reconnect(true); break;
      case 9: // INVALID SESSION
        if (!p.d) { this.sessionId = null; this.seq = null; }
        setTimeout(() => this.reconnect(!!p.d), 1000 + Math.random() * 4000);
        break;
      case 0:
        if (p.t === 'READY') {
          this.sessionId = p.d.session_id;
          this.resumeUrl = p.d.resume_gateway_url;
          this.backoff = 1000;
        }
        if (p.t === 'RESUMED') this.backoff = 1000;
        this.emit('dispatch', p.t, p.d);
        break;
      default: break;
    }
  }

  beat() {
    if (!this.acked) { this.reconnect(true); return; } // zombie connection
    this.acked = false;
    this.send(1, this.seq);
  }

  reconnect(resume) {
    clearInterval(this.hbTimer);
    const old = this.ws;
    this.ws = null;
    if (!resume) { this.sessionId = null; this.seq = null; }
    try { if (old) old.close(4000, 'reconnect'); } catch { /* ignore */ }
    if (this.stopped) return;
    const url = resume && this.resumeUrl ? this.resumeUrl : this.baseUrl;
    setTimeout(() => this.open(url), 250);
  }

  onClose(code) {
    clearInterval(this.hbTimer);
    this.ws = null;
    if (this.stopped) return;
    if (code === 4014 && (this.intents & INTENTS.GUILD_PRESENCES)) {
      this.intents &= ~INTENTS.GUILD_PRESENCES;
      this.sessionId = null; this.seq = null;
      this.emit('warn', 'Presence Intent is not enabled in the Discord Developer Portal. Auto go-live detection from Discord is off until you enable it (see setup guide). Running without it.');
      setTimeout(() => this.open(this.baseUrl), 1000);
      return;
    }
    if (FATAL.has(code) || code === 4014) {
      this.emit('fatal', code === 4004 ? 'Discord rejected the bot token (DISCORD_TOKEN). Reset it in the Developer Portal and update the variable.' : `Gateway closed with code ${code}.`);
      return;
    }
    if (code === 4007 || code === 4009) { this.sessionId = null; this.seq = null; }
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    setTimeout(() => this.open(this.sessionId && this.resumeUrl ? this.resumeUrl : this.baseUrl), wait);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.hbTimer);
    try { if (this.ws) this.ws.close(1000); } catch { /* ignore */ }
  }
}

module.exports = { Gateway, INTENTS };

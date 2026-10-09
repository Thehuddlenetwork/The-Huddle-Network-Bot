'use strict';
// Minimal Discord REST client with rate-limit handling.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DiscordAPIError extends Error {
  constructor(status, data, method, path) {
    super(`Discord API ${status} on ${method} ${path}: ${data && data.message ? data.message : JSON.stringify(data)}`);
    this.status = status;
    this.code = data && data.code;
    this.data = data;
  }
}

class Rest {
  constructor({ token, base, fetchImpl }) {
    this.token = token;
    this.base = base;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.buckets = new Map(); // routeKey -> resetAt (ms) when remaining hit 0
  }

  static routeKey(method, path) {
    // Keep the first id (channel/guild/webhook) — Discord's "major parameter" — and generalise the rest.
    let seen = 0;
    const p = path.replace(/\/(\d{15,21})/g, (m) => (seen++ === 0 ? m : '/:id'))
      .replace(/\/interactions\/:id\/[^/]+/, '/interactions/:id/:token')
      .replace(/\/reactions\/.*/, '/reactions');
    return `${method} ${p}`;
  }

  async request(method, path, { body, files, reason, auth = true } = {}) {
    const key = Rest.routeKey(method, path);
    for (let attempt = 0; attempt < 6; attempt++) {
      const resetAt = this.buckets.get(key);
      if (resetAt && resetAt > Date.now()) await sleep(resetAt - Date.now() + 25);

      const headers = { 'User-Agent': 'DiscordBot (https://discord.com, 1.0) HuddleHQ' };
      if (auth && this.token) headers.Authorization = `Bot ${this.token}`;
      if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);

      let payload;
      if (files && files.length) {
        const form = new FormData();
        const json = { ...(body || {}), attachments: files.map((f, i) => ({ id: i, filename: f.name })) };
        form.append('payload_json', JSON.stringify(json));
        files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name));
        payload = form;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }

      let res;
      try {
        res = await this.fetch(this.base + path, { method, headers, body: payload });
      } catch (e) {
        if (attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }
        throw e;
      }

      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAfter = res.headers.get('x-ratelimit-reset-after');
      if (remaining === '0' && resetAfter) this.buckets.set(key, Date.now() + Number(resetAfter) * 1000);
      else this.buckets.delete(key);

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        await sleep(Math.ceil((Number(data.retry_after) || 1) * 1000) + 50);
        continue;
      }
      if (res.status >= 500 && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }
      if (res.status === 204) return null;

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) throw new DiscordAPIError(res.status, data, method, path);
      return data;
    }
    throw new Error(`Gave up after repeated rate limits: ${method} ${path}`);
  }
}

module.exports = { Rest, DiscordAPIError };

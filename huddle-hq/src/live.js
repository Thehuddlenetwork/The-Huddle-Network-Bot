'use strict';
// Go-live detection: Discord streaming status (Twitch/YouTube), Twitch API (optional), and /golive (TikTok etc).
const db = require('./db');
const config = require('./config');
const api = require('./discord/api');
const members = require('./services/members');
const games = require('./services/games');
const stands = require('./services/stands');
const gameView = require('./views/game');
const ui = require('./lib/ui');
const { ts, MIN } = require('./lib/time');
const { LEAGUES, BRAND } = require('./constants');

const streamingNow = new Map(); // userId -> url (from Discord presence)

function platformOf(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('twitch.tv')) return 'Twitch';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('kick.com')) return 'Kick';
  return 'Stream';
}

// Returns { session, hits, isNew }
async function goLive(userId, { url = null, source = 'manual', title = null, streamKey = null, gameId = null } = {}) {
  const m = members.get(userId);
  const now = Date.now();
  let sess = games.openSession(userId, now);
  let isNew = false;
  if (!sess) {
    // A stream that dropped in the last 15 minutes is the same broadcast.
    const recent = db.one('SELECT * FROM live_sessions WHERE user_id = ? AND ended_at >= ? ORDER BY ended_at DESC LIMIT 1', userId, now - 15 * MIN);
    if (recent) {
      db.run('UPDATE live_sessions SET ended_at = NULL WHERE id = ?', recent.id);
      sess = { ...recent, ended_at: null };
    } else {
      const link = url || (m && m.stream_url) || null;
      const r = db.run('INSERT INTO live_sessions (user_id, source, stream_key, url, title, started_at) VALUES (?,?,?,?,?,?)',
        userId, source, streamKey, link, title, now);
      sess = db.one('SELECT * FROM live_sessions WHERE id = ?', r.lastInsertRowid);
      isNew = true;
    }
  }
  const link = url || sess.url || (m && m.stream_url) || null;

  const hits = games.checkIn(userId, { url: link, at: now, gameId });
  for (const h of hits) {
    if (h.first) {
      const extra = gameView.paidText(h.paid);
      await gameView.say(h.game.id, `🔴 ${ui.mention(userId)} is live${link ? ` · [watch](${link})` : ''}${extra ? ` · ${extra} credits` : ''}`);
    }
    await gameView.refresh(h.game.id);
  }

  if (isNew && m && m.status === 'active') {
    const upcoming = hits[0] ? hits[0].game : null;
    const lines = [];
    if (m.team) lines.push(`**${m.team}** · ${LEAGUES[m.league] || ''}`);
    if (upcoming) {
      lines.push(`On now: **${games.label(upcoming)}**${upcoming.locked_at ? ` · kickoff ${ts(upcoming.locked_at, 't')}` : ''}`);
      if (upcoming.gotw) lines.push('⭐ **GAME OF THE WEEK**');
    }
    if (title) lines.push(`> ${ui.clip(title, 200)}`);
    await api.post('goLive', {
      embeds: [ui.embed({ title: `🔴 LIVE NOW  |  ${(m.streamer_name || 'THN Member').toUpperCase()}`, description: lines.join('\n') || 'Live on THN.', url: link || undefined, color: BRAND.red, timestamp: true })],
      components: link ? ui.rows([ui.linkButton(link, `Watch on ${platformOf(link)}`)]) : [],
    });
    // Fresh THN Passport code for this broadcast
    const code = stands.newCode(userId);
    await api.dm(userId, {
      embeds: [ui.embed({
        title: 'YOUR THN PASSPORT CODE',
        description: `**${code.code}**\n\nShow it on stream once, at a random moment. Viewers stamp it with \`/passport stamp\` in the THN Discord. Valid until ${ts(code.expiresAt, 't')}.`,
        color: BRAND.black,
      })],
    });
  }
  return { session: sess, hits, isNew, url: link };
}

function endSession(userId, source = null) {
  if (source) db.run('UPDATE live_sessions SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL AND source = ?', Date.now(), userId, source);
  else db.run('UPDATE live_sessions SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL', Date.now(), userId);
}

// PRESENCE_UPDATE from the gateway
async function onPresence(d) {
  const userId = d && d.user && d.user.id;
  if (!userId) return;
  const activity = (d.activities || []).find((a) => a.type === 1 && a.url);
  const prev = streamingNow.get(userId);
  if (activity && !prev) {
    streamingNow.set(userId, activity.url);
    const m = members.get(userId);
    if (!m || m.status !== 'active') return;
    await goLive(userId, { url: activity.url, source: 'discord', title: activity.details || activity.state || null });
  } else if (!activity && prev) {
    streamingNow.delete(userId);
    endSession(userId, 'discord');
  }
}

function seedPresences(list) {
  for (const p of list || []) {
    const a = (p.activities || []).find((x) => x.type === 1 && x.url);
    if (a && p.user) streamingNow.set(p.user.id, a.url);
  }
}

// ---------- Twitch (optional) ----------
let twitchToken = null;
let twitchTokenExp = 0;
const twitchLive = new Map(); // login -> stream id

async function twitchAuth() {
  if (twitchToken && Date.now() < twitchTokenExp - 60000) return twitchToken;
  const res = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(config.twitchClientId)}&client_secret=${encodeURIComponent(config.twitchClientSecret)}&grant_type=client_credentials`, { method: 'POST' });
  if (!res.ok) throw new Error(`Twitch auth failed (${res.status})`);
  const j = await res.json();
  twitchToken = j.access_token;
  twitchTokenExp = Date.now() + j.expires_in * 1000;
  return twitchToken;
}

async function pollTwitch() {
  if (!config.twitchClientId || !config.twitchClientSecret) return;
  const list = members.active().filter((m) => m.twitch_login);
  if (!list.length) return;
  const token = await twitchAuth();
  const live = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const qs = chunk.map((m) => `user_login=${encodeURIComponent(m.twitch_login)}`).join('&');
    const res = await fetch(`https://api.twitch.tv/helix/streams?${qs}`, { headers: { 'Client-Id': config.twitchClientId, Authorization: `Bearer ${token}` } });
    if (res.status === 401) { twitchToken = null; return; }
    if (!res.ok) throw new Error(`Twitch streams ${res.status}`);
    const j = await res.json();
    for (const s of j.data || []) live.set(s.user_login.toLowerCase(), s);
  }
  for (const m of list) {
    const s = live.get(m.twitch_login);
    if (s && twitchLive.get(m.twitch_login) !== s.id) {
      twitchLive.set(m.twitch_login, s.id);
      await goLive(m.user_id, { url: `https://twitch.tv/${m.twitch_login}`, source: 'twitch', title: s.title, streamKey: s.id });
    } else if (!s && twitchLive.has(m.twitch_login)) {
      twitchLive.delete(m.twitch_login);
      endSession(m.user_id, 'twitch');
    }
  }
}

function startTwitch() {
  if (!config.twitchClientId || !config.twitchClientSecret) return false;
  const run = () => pollTwitch().catch((e) => console.warn(`[twitch] ${e.message}`));
  setTimeout(run, 15000);
  setInterval(run, 2 * 60 * 1000);
  return true;
}

module.exports = { goLive, endSession, onPresence, seedPresences, startTwitch, pollTwitch, platformOf };

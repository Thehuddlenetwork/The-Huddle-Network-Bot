'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS members (
  user_id TEXT PRIMARY KEY,
  streamer_name TEXT, stream_url TEXT, twitch_login TEXT, gamertag TEXT,
  timezone TEXT DEFAULT 'PT', availability_note TEXT, avail_days TEXT, avail_windows TEXT,
  status TEXT DEFAULT 'applied',
  league TEXT, team TEXT,
  academy_level INTEGER DEFAULT 0,
  ontime_streak INTEGER DEFAULT 0, best_ontime_streak INTEGER DEFAULT 0,
  complete_streak INTEGER DEFAULT 0,
  trade_unfrozen_season INTEGER,
  applied_at INTEGER, joined_at INTEGER, updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS members_team ON members(league, team) WHERE team IS NOT NULL;

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER, league TEXT, week INTEGER,
  away_team TEXT, home_team TEXT,
  status TEXT DEFAULT 'scheduled',
  advance_at INTEGER,
  proposed_at INTEGER, proposed_by TEXT, proposed_on INTEGER,
  locked_at INTEGER, locked_on INTEGER,
  kickoff_at INTEGER, kickoff_by TEXT,
  away_score INTEGER, home_score INTEGER, final_by TEXT, final_at INTEGER, completed_at INTEGER,
  winner TEXT, gotw INTEGER DEFAULT 0,
  channel_id TEXT, message_id TEXT, thread_id TEXT,
  flags TEXT DEFAULT '{}',
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS games_week ON games(season, league, week);
CREATE INDEX IF NOT EXISTS games_thread ON games(thread_id);

CREATE TABLE IF NOT EXISTS game_players (
  game_id INTEGER, side TEXT, user_id TEXT,
  checkin_at INTEGER, stream_url TEXT, verified INTEGER DEFAULT 0,
  arrival_at INTEGER, minutes_late INTEGER, timing TEXT,
  outcome TEXT, no_credit INTEGER DEFAULT 0,
  ontime_paid INTEGER DEFAULT 0, complete_paid INTEGER DEFAULT 0, double_paid INTEGER DEFAULT 0,
  vod_url TEXT, vod_paid INTEGER DEFAULT 0,
  PRIMARY KEY (game_id, side)
);
CREATE INDEX IF NOT EXISTS gp_user ON game_players(user_id);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, amount INTEGER,
  category TEXT, reason TEXT, ref TEXT, by_user TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, category, created_at);
CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(user_id, category, ref);

CREATE TABLE IF NOT EXISTS strikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, season INTEGER, kind TEXT, reason TEXT,
  game_id INTEGER, issued_by TEXT, voided INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, reason TEXT, status TEXT DEFAULT 'open', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS audibles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, season INTEGER, game_id INTEGER, late INTEGER DEFAULT 0, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, cost INTEGER, description TEXT, stock INTEGER DEFAULT -1, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, item_id INTEGER, item_name TEXT, cost INTEGER,
  status TEXT DEFAULT 'open', handled_by TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, season INTEGER, league TEXT, week INTEGER,
  from_user TEXT, to_user TEXT, from_team TEXT, to_team TEXT,
  sending TEXT, receiving TEXT, why_from TEXT, why_to TEXT,
  status TEXT, created_at INTEGER, voting_at INTEGER, decided_at INTEGER,
  desk_channel TEXT, desk_message TEXT, vote_channel TEXT, vote_message TEXT,
  wire_channel TEXT, wire_message TEXT, grade_from TEXT, grade_to TEXT
);
CREATE TABLE IF NOT EXISTS trade_votes (
  trade_id INTEGER, voter_id TEXT, vote TEXT, created_at INTEGER, PRIMARY KEY (trade_id, voter_id)
);

CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, url TEXT, type TEXT, game_id INTEGER,
  vertical INTEGER DEFAULT 0, note TEXT, status TEXT DEFAULT 'pending', featured INTEGER DEFAULT 0,
  milestones TEXT DEFAULT '', credited INTEGER DEFAULT 0, reviewed_by TEXT, created_at INTEGER,
  channel_id TEXT, message_id TEXT
);
CREATE TABLE IF NOT EXISTS clip_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, clip_ids TEXT, status TEXT DEFAULT 'open', closes_at INTEGER,
  channel_id TEXT, message_id TEXT, winner_clip INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS clip_votes (
  poll_id INTEGER, voter_id TEXT, clip_id INTEGER, PRIMARY KEY (poll_id, voter_id)
);

CREATE TABLE IF NOT EXISTS academy_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, level INTEGER, proof TEXT, notes TEXT,
  status TEXT DEFAULT 'pending', feedback TEXT, reviewed_by TEXT, created_at INTEGER,
  channel_id TEXT, message_id TEXT
);

CREATE TABLE IF NOT EXISTS score_ratings (
  user_id TEXT, category TEXT, value INTEGER, updated_at INTEGER, PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS passport_codes (
  code TEXT PRIMARY KEY, streamer_id TEXT, created_at INTEGER, expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS passport_stamps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, viewer_id TEXT, code TEXT, streamer_id TEXT, created_at INTEGER,
  UNIQUE(viewer_id, code)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, credits INTEGER, closes_at INTEGER, created_by TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS eliminations (
  season INTEGER, league TEXT, team TEXT, week INTEGER, PRIMARY KEY (season, league, team)
);
CREATE TABLE IF NOT EXISTS award_votes (
  season INTEGER, category TEXT, voter_id TEXT, nominee_id TEXT, PRIMARY KEY (season, category, voter_id)
);
CREATE TABLE IF NOT EXISTS live_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, source TEXT, stream_key TEXT, url TEXT, title TEXT,
  started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS live_user ON live_sessions(user_id, ended_at);
CREATE TABLE IF NOT EXISTS job_runs (key TEXT PRIMARY KEY, ran_at INTEGER);
`;

let db = null;
let depth = 0;
const cache = new Map();

function init(file) {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  cache.clear();
  depth = 0;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

function handle() {
  if (!db) throw new Error('Database not initialised');
  return db;
}

function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = handle().prepare(sql); cache.set(sql, s); }
  return s;
}

function bind(params) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

const plain = (row) => (row ? { ...row } : null);

function one(sql, ...params) { return plain(stmt(sql).get(...bind(params))); }
function all(sql, ...params) { return stmt(sql).all(...bind(params)).map(plain); }
function run(sql, ...params) { return stmt(sql).run(...bind(params)); }
function exec(sql) { handle().exec(sql); }

// Synchronous transaction. Nested calls join the outer transaction.
function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  handle().exec('BEGIN');
  try {
    const result = fn();
    handle().exec('COMMIT');
    return result;
  } catch (err) {
    try { handle().exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    depth--;
  }
}

// Consistent snapshot copy of the database (used for backups).
function backupTo(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  handle().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

module.exports = { init, one, all, run, exec, tx, backupTo, handle };

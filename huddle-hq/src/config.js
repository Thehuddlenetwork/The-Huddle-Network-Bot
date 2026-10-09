'use strict';
const path = require('path');

// Everything secret or environment-specific comes from environment variables.
// On Railway, set these under the service's "Variables" tab.
module.exports = {
  token: (process.env.DISCORD_TOKEN || '').trim(),
  guildId: (process.env.GUILD_ID || '').trim(),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'huddle.db'),
  presence: process.env.PRESENCE_DETECTION !== 'false',
  twitchClientId: (process.env.TWITCH_CLIENT_ID || '').trim(),
  twitchClientSecret: (process.env.TWITCH_CLIENT_SECRET || '').trim(),
  apiBase: process.env.DISCORD_API_BASE || 'https://discord.com/api/v10',
  zone: 'America/Los_Angeles',
};

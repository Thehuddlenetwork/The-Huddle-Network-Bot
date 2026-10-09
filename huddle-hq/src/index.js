'use strict';
// Huddle HQ — the official Discord app of The Huddle Network.
const config = require('./config');
const db = require('./db');
const settings = require('./settings');
const api = require('./discord/api');
const router = require('./discord/router');
const { Rest } = require('./discord/rest');
const { Gateway, INTENTS } = require('./discord/gateway');
const ui = require('./lib/ui');
const shop = require('./services/shop');
const league = require('./services/league');

function fail(msg) {
  console.error(`\n[huddle-hq] ${msg}\n`);
  process.exit(1);
}

if (!config.token) fail('DISCORD_TOKEN is missing. Add it in Railway → your service → Variables.');
if (!config.guildId) fail('GUILD_ID is missing. Right-click your server icon → Copy Server ID (turn on Developer Mode first), then add it in Variables.');

db.init(config.dbPath);
shop.seed();
league.ensureClock();
ui.setLogo(settings.get('logo_url'));

const MODULES = ['setup', 'members', 'games', 'league', 'economy', 'trades', 'clips', 'academy', 'network'];
for (const name of MODULES) router.register(require(`./modules/${name}`));

const live = require('./live');
const notify = require('./notify');
const scheduler = require('./scheduler');

const rest = new Rest({ token: config.token, base: config.apiBase });
api.configure({ rest, guildId: config.guildId });

const intents = INTENTS.GUILDS | (config.presence ? INTENTS.GUILD_PRESENCES : 0);
const gateway = new Gateway({ token: config.token, intents, rest });

let booted = false;
gateway.on('dispatch', async (type, d) => {
  try {
    if (type === 'READY') {
      api.setIdentity({ appId: d.application.id, botId: d.user.id });
      console.log(`[huddle-hq] connected as ${d.user.username}`);
      if (!booted) {
        booted = true;
        const defs = router.definitions();
        try {
          await api.registerCommands(defs);
          console.log(`[huddle-hq] registered ${defs.length} slash commands`);
        } catch (e) {
          console.error('[huddle-hq] command registration failed. Is the bot in the server with the applications.commands scope?', e.message);
        }
        notify.attach();
        scheduler.start();
        if (live.startTwitch()) console.log('[huddle-hq] Twitch go-live detection on');
      }
    } else if (type === 'GUILD_CREATE' && d.id === config.guildId) {
      live.seedPresences(d.presences);
    } else if (type === 'INTERACTION_CREATE') {
      await router.handle(d, { guildId: config.guildId });
    } else if (type === 'PRESENCE_UPDATE' && d.guild_id === config.guildId) {
      await live.onPresence(d);
    }
  } catch (e) {
    console.error(`[huddle-hq] ${type} handler error:`, e);
  }
});
gateway.on('warn', (m) => console.warn(`[huddle-hq] ${m}`));
gateway.on('fatal', (m) => fail(m));

gateway.connect().catch((e) => fail(`Could not reach Discord: ${e.message}`));

function shutdown() {
  console.log('[huddle-hq] shutting down');
  gateway.stop();
  require('./notify').flushCredits().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('[huddle-hq] unhandled rejection:', e));

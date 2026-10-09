# Huddle HQ

The official Discord app of **The Huddle Network**. It runs game day (game times, live check-ins, kickoffs, finals, rulings), the credits economy and shop, the Trade Desk, the Highlight Reel, the Huddle Academy, Creator Score, In The Stands, the THN Passport and the Huddle Awards. It runs alongside Franchise Hub, which keeps stats, exports, recaps and the sportsbook.

There are no packages to install. It needs **Node.js 22**, plus a Discord bot token and your server ID.

## Run it on Railway

1. Put this folder in a GitHub repository.
2. In Railway, choose New Project, then Deploy from GitHub repo.
3. Add a **Volume** to the service with the mount path `/data`.
4. Set these Variables:
   - `DISCORD_TOKEN`: from the Discord Developer Portal, under Bot
   - `GUILD_ID`: your server ID
   - `DB_PATH`: `/data/huddle.db`
   - optional: `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`
5. Deploy. Then run `/setup auto` in Discord.

The full walkthrough is in **Huddle HQ Setup Guide.pdf**.

## Run it on your own computer

```
cp .env.example .env    # fill in DISCORD_TOKEN and GUILD_ID, and set DB_PATH=./data/huddle.db
npm run dev
```

## Tests

`npm test` runs 36 tests: a full season walk-through against a fake Discord, every command and subcommand, the gateway and rate-limit handling, and the time-zone math.

## Where things live

- `src/constants.js`: credit values, limits, Academy levels, award categories, channel and role names
- `src/services/`: league rules (games, credits, strikes, trades, clips, academy, score, stands, awards, shop)
- `src/modules/`: slash commands, buttons and forms
- `src/scheduler.js`: everything that runs on the clock
- `src/discord/`: the Discord connection (gateway and REST), written with no dependencies

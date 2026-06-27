# 🌲 Survivor — The Forest Achievement Bot

A Discord bot for a small gaming friend group that plays **The Forest** on Steam.
It polls everyone's Steam achievements, awards points, ranks a leaderboard, hands
out reward roles at milestones, and trash-talks the whole way through as
**"Survivor"** — a sarcastic forest castaway powered by Google Gemini.

---

## Features

- **Steam achievement tracking** — polls every linked member's Steam account
  every 5 minutes for **The Forest** (`242760`) **and Sons of the Forest**
  (`1326470`).
- **Points & rewards** — `+10` points per new achievement; a milestone
  announcement at every 100 points.
- **Survivor's personality** — an AI castaway (Google Gemini, `gemini-2.5-flash`)
  that reacts to every unlock, celebrates milestones, holds conversations, and
  asks the group random questions.
- **Announcements** in your achievement channel.
- **Automatic reward roles** at 100 / 200 / 300 / 500 points.
- **SQLite storage** — points, achievements, and chat memory persist in
  `survivor.db`.
- **Optional extras** (all off by default — see `.env.example`):
  - **Now-playing pings** — a line when someone boots up a tracked game.
  - **Weekly recap** — a ~weekly post of who earned the most.
  - **Backfill** — count members' *existing* achievements on first run.
  - **Health alerts** — get pinged if Steam or Gemini starts failing.

### Commands

Available as both slash commands (`/points`) and prefix commands (`!points`).

| Command | What it does |
| --- | --- |
| `/leaderboard` | Shows all members ranked by points |
| `/points` | Shows your own points |
| `/achievements [user]` | Lists achievements you (or someone) have unlocked |
| `/progress [user]` | Shows achievement completion % per game |
| `/link <steamid64>` | Links your Discord account to your Steam ID |
| `/survey` | Survivor asks the group a random fun question |
| `/addpoints <user> <amount>` | **(Admin)** Add points (negative to subtract) |
| `/setpoints <user> <amount>` | **(Admin)** Set a player's point total |

> Slash commands require inviting the bot with the **`applications.commands`**
> scope (see `SETUP.md` Part 2d). Admin commands are restricted to members with
> the **Administrator** permission.

### Talking to Survivor

Survivor talks in **exactly one channel** — the one you set as
`SURVIVOR_CHAT_CHANNEL_ID`. In that channel he replies to **every** message and
holds a real back-and-forth conversation. Because each message is tagged with the
speaker's name, the whole group can talk to him at once and he answers each
person specifically. A per-user **cooldown** (`CHAT_COOLDOWN_MS`) keeps it from
spamming the Gemini API.

He stays **completely silent in every other channel and in DMs**. (The commands
still work anywhere.)

Conversation memory is **persisted to the database**, so he remembers the recent
chat even across restarts/redeploys.

### What about achievements members already have?

The first time the bot sees a player it has two modes, controlled by
`BACKFILL_EXISTING`:

- **`false` (default)** — their existing achievements are recorded silently as a
  baseline. **No points, no announcements.** Only achievements unlocked *after*
  this point earn points. (Avoids a day-one flood of spam.)
- **`true`** — their existing achievements are **counted immediately**: the bot
  awards `+10` each, posts **one** summary message (not one per achievement), and
  assigns whatever reward roles they've earned. Use this if you want everyone to
  start with scores reflecting what they've already done.

### Milestone rewards

| Points | Reward | Discord role assigned |
| --- | --- | --- |
| 100 | 🎖️ Forest Rookie | `Forest Rookie` |
| 200 | 🪓 Axe Master | `Axe Master` |
| 300 | 🏠 Base Builder | `Base Builder` |
| 500 | 👑 Forest Legend | `Forest Legend` |

> Milestones at 400, 600, 700… still get a celebration announcement, just no
> dedicated role.

---

## Prerequisites

- **Node.js 18+** (developed on Node 24)
- A **Discord bot** application
- A **Steam Web API key**
- A **Google Gemini API key**

---

## 1. Get your API keys & IDs

### Discord bot token
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token → `DISCORD_BOT_TOKEN`.
3. Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT** and
   **SERVER MEMBERS INTENT** (both are required).
4. **OAuth2 → URL Generator**: scope `bot`, permissions
   **Send Messages**, **Read Message History**, **Manage Roles**. Open the
   generated URL to invite the bot to your server.

### Achievement channel ID
1. Discord → **User Settings → Advanced → Developer Mode** (on).
2. Right-click your `#achievements` channel → **Copy Channel ID** →
   `ACHIEVEMENT_CHANNEL_ID`.

### Steam Web API key
- Get one at <https://steamcommunity.com/dev/apikey> → `STEAM_API_KEY`.
- Each member's **Steam profile and game details must be public** (Steam →
  Profile → Edit Profile → Privacy → *My profile* and *Game details* = Public),
  otherwise their achievements can't be read.

### Google Gemini API key
- Get one at <https://aistudio.google.com/apikey> → `GEMINI_API_KEY`.

### SteamID64s
- Each member can find theirs at <https://steamid.io/> (the 17-digit
  `steamID64`), or link in Discord later with `!link <steamid64>`.

---

## 2. Create the reward roles in Discord

Create four roles with these **exact names**:
`Forest Rookie`, `Axe Master`, `Base Builder`, `Forest Legend`.

> **Important:** drag the **bot's own role above all four** in
> **Server Settings → Roles**. Discord only lets a bot assign roles that sit
> *below* its highest role.

---

## 3. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```env
DISCORD_BOT_TOKEN=...
STEAM_API_KEY=...
GEMINI_API_KEY=...
ACHIEVEMENT_CHANNEL_ID=123456789012345678
# Optional pre-seed of Discord-ID:SteamID64 pairs (members can also use !link):
STEAM_IDS=111111111111111111:76561197960287930,222222222222222222:76561198000000000
```

To find a member's Discord ID: Developer Mode on → right-click the user →
**Copy User ID**.

---

## 4. Run

```bash
npm install
node index.js
```

You should see `✅ Survivor is awake as <BotName>` and
`⏱️  Polling Steam every 300s`.

> **First poll is silent.** When the bot first sees a linked player, it records
> their *existing* achievements as a baseline **without** awarding points or
> announcing them (otherwise day one would be a flood of spam). Only achievements
> unlocked **after** the bot starts tracking earn points. Newly linked members
> are baselined on the next poll automatically.

---

## Hosting free on Railway.app

[Railway](https://railway.app) runs the bot 24/7 so it keeps polling even when
your computer is off. The free trial / hobby tier is plenty for a 5-person bot.

1. Push this project to a **GitHub repo** (the included `.gitignore` keeps
   `.env`, `node_modules/`, and the `*.db` files out — never commit secrets).
2. On Railway: **New Project → Deploy from GitHub repo** → pick your repo.
3. Railway auto-detects Node.js and runs `npm install` then `npm start`
   (the `start` script is already defined in `package.json`).
4. Open the service → **Variables** tab → add each variable from your `.env`:
   `DISCORD_BOT_TOKEN`, `STEAM_API_KEY`, `GEMINI_API_KEY`,
   `ACHIEVEMENT_CHANNEL_ID`, `SURVIVOR_CHAT_CHANNEL_ID`, and (optionally)
   `STEAM_IDS` plus any feature toggles from `.env.example`.
5. **Deploy.** Watch the **Deploy Logs** for `✅ Survivor is awake`.

### Keeping the database between deploys (recommended)

The bot stores points in `survivor.db` on local disk. On Railway, the filesystem
is **wiped on every redeploy** unless you attach a volume:

1. Service → **Settings → Volumes → New Volume**.
2. Mount it at `/app` (Railway's default app directory) or another path, and the
   SQLite file will persist across deploys.

Without a volume the bot still works, but a redeploy resets everyone's points and
re-baselines achievements.

---

## Project structure

```
.
├── index.js          # Discord client, polling loop, commands, role assignment
├── src/
│   ├── db.js         # SQLite (better-sqlite3) — players & achievements
│   ├── steam.js      # Steam Web API calls (achievements + display names)
│   ├── survivor.js   # Survivor's personality via the Google Gemini API
│   └── rewards.js    # Milestone → reward/role mapping
├── .env.example
└── README.md
```

---

## Troubleshooting

- **No achievement announcements** — confirm the member's Steam profile and
  *game details* are public, that their SteamID64 is correct (`!link`), and that
  they actually own The Forest on that account.
- **Roles aren't assigned** — the bot's role must be **above** the reward roles,
  and the bot needs **Manage Roles**. Check the logs for a `[roles] failed…` line.
- **Survivor is quiet / generic** — a missing or invalid `GEMINI_API_KEY` makes
  it fall back to canned lines (announcements still post). Check the logs for
  `[survivor] Gemini API error`.
- **Bot ignores commands / mentions** — enable **MESSAGE CONTENT INTENT** in the
  Developer Portal.

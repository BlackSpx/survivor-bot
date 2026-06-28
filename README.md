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
- **Points & rewards** — `+10` points per new achievement, plus bonuses:
  - 🩸 **First Blood** `+15` — the first member of the group to unlock a given
    achievement.
  - 💎 **Rarity bonus** — `+30 / +15 / +5` for globally rare achievements
    (≤2% / ≤10% / ≤25% of all Steam owners have it).
  - 🔥 **Streak bonus** — `+2` per consecutive day you unlock something, capped
    at `+20`. Miss a day and the streak resets.

  A milestone announcement fires at every 100 points.
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
| `/help` | Lists every command (with a points explainer) |
| `/stats [user]` | A survivor card (with the player's Steam avatar): points, rank, streak, role, next reward |
| `/rank` | Your spot on the leaderboard + who's just ahead |
| `/leaderboard` | Shows all members ranked by points |
| `/points` | Shows your own points |
| `/achievements [user]` | Lists achievements you (or someone) have unlocked |
| `/progress [user]` | Shows achievement completion % per game |
| `/link <steamid64>` | Links your Steam ID (rejected with instructions if your profile is private) |
| `/unlink` | Removes your Steam link (keeps your points) |
| `/survey` | Survivor asks the group a random fun question |
| `/addpoints <user> <amount>` | **(Admin)** Add points (negative to subtract) |
| `/setpoints <user> <amount>` | **(Admin)** Set a player's point total |
| `/backup` | **(Admin)** DM yourself a full DB backup + a readable CSV of every player |

> Slash commands require inviting the bot with the **`applications.commands`**
> scope (see `SETUP.md` Part 2d). Admin commands are restricted to the Discord
> user IDs listed in **`ADMIN_DISCORD_IDS`** (falling back to `OWNER_DISCORD_ID`);
> if neither is set, they fall back to members with the **Administrator**
> permission. The admin section of `/help` is hidden from everyone else.

### Talking to Survivor

Survivor talks in **exactly one server channel** — the one you set as
`SURVIVOR_CHAT_CHANNEL_ID`. In that channel he replies to **every** message and
holds a real back-and-forth conversation. Because each message is tagged with the
speaker's name, the whole group can talk to him at once and he answers each
person specifically. A per-user **cooldown** (`CHAT_COOLDOWN_MS`) keeps it from
spamming the Gemini API.

He also chats **one-on-one in DMs**, but only with **linked players** and only
about **video games** — DM him anything off-topic and he'll deflect it in
character. (Unlinked users just get nudged to `!link` first.) He stays silent in
every *other* server channel, though commands work anywhere.

**Personality:** he's a sarcastic, hard-to-get gamer — short and sharp for
casual banter, but he drops the act and gives a real, detailed answer when you
actually ask for a guide, boss strategy, build, or game recommendation (any
game, not just The Forest).

Conversation memory is **persisted to the database**, so he remembers the recent
chat even across restarts/redeploys.

### Telling Survivor who his owner is

When someone asks Survivor **"who owns / made / runs this bot?"** (even in DMs),
he answers in character — naming you and pointing people at whichever of your
profiles you've shared. He **never volunteers it unless asked.**

Set any combination of these in `.env` (or your Railway Variables). All are
optional — fill in only what you want public:

```env
# Your display name — Survivor calls you this.
OWNER_NAME=Greg
# Your Discord user ID — shown as a clickable @mention.
# (Developer Mode on → right-click yourself → Copy User ID)
OWNER_DISCORD_ID=111111111111111111
# Your Steam — a profile URL or just a handle, shown as plain text.
OWNER_STEAM=https://steamcommunity.com/id/yourvanity
# "true" to actually ping you when Survivor names you. Default false
# (the mention still links, it just won't notify you every time).
OWNER_PING=false
```

| Field | What people see when they ask |
| --- | --- |
| `OWNER_NAME` | Your name in Survivor's reply |
| `OWNER_DISCORD_ID` | A clickable Discord mention linking to you |
| `OWNER_STEAM` | Your Steam profile URL / handle as plain text |

Leave all three blank to disable the feature entirely (Survivor just won't claim
an owner). Note `OWNER_DISCORD_ID` is also reused as the admin fallback — see
[Admin commands](#commands) and `ADMIN_DISCORD_IDS` in `.env.example`.

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
your computer is off. The free trial / hobby tier is plenty for a small friend group.

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
2. Mount it at **`/data`** (use a dedicated path, *not* `/app` — that would
   overlay your deployed code).
3. Add a Variable **`DATABASE_PATH=/data/survivor.db`** so the bot writes the
   database onto the volume instead of the ephemeral disk.
4. Redeploy. Points and achievements now persist across deploys.

Without a volume the bot still works, but a redeploy resets everyone's points and
re-baselines achievements. To back up the data at any time, run the admin
`!backup` command — Survivor DMs you the full `.db` plus a readable CSV.

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

- **`!link` says my profile is private** — that's by design: the bot won't link
  a profile it can't read. Set **My profile** and **Game details** to Public
  (Steam → Edit Profile → Privacy), then run `!link <steamid64>` again.
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

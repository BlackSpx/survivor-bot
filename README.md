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
- **Voice activity** (optional) — tracks time linked players spend in your game
  voice channel and awards bonus points at hour milestones (Voice Newbie →
  Voice Legend). Can also DM + kick unlinked users who join.
- **Optional extras** (all off by default — see `.env.example`):
  - **Now-playing pings** — a line when someone boots up a tracked game.
  - **All-games tracking** — count achievements from *any* recently-played game,
    not just the two Forest games (`TRACK_ALL_GAMES`).
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
| `/link <steamid64>` | Links your Steam ID (rejected if private; one Steam per person — `/unlink` first to switch) |
| `!link @user` | Looks up who that member has linked (prefix-only; anyone can use it) |
| `/unlink` | Removes your Steam link (keeps your points) |
| `/survey` | Survivor asks the group a random fun question |
| `/feedback` | Opens a form to send the admins a bug report or suggestion (`!feedback` posts a button that opens the same form) |
| `/prize` | View (and claim) the prize an admin set for you — the **Take Prize** button unlocks at 500 pts |
| `/addpoints <user> <amount>` | **(Admin)** Add points (negative to subtract) |
| `/setpoints <user> <amount>` | **(Admin)** Set a player's point total |
| `!chatlimit [<n>]` | **(Admin)** Show or set the chat channel's messages-per-hour limit (persists across restarts); prefix-only |
| `!prizefor [@user]` | **(Admin)** Set a prize image for a player — lists linked players to pick from if no `@user` (prefix flow); `/prizefor <user> <image> [notes]` does it in one shot |
| `/backup` | **(Admin)** DM yourself a full DB backup + a readable CSV of every player |

> Slash commands require inviting the bot with the **`applications.commands`**
> scope (see `SETUP.md` Part 2d). Admin commands are restricted to the Discord
> user IDs listed in **`ADMIN_DISCORD_IDS`** (falling back to `OWNER_DISCORD_ID`);
> if neither is set, they fall back to members with the **Administrator**
> permission. The admin section of `/help` is hidden from everyone else.

### Talking to Survivor

Survivor talks in **exactly one server channel** — the one you set as
`SURVIVOR_CHAT_CHANNEL_ID`. In that channel he replies to **every** message and
holds a real back-and-forth conversation, **@mentioning the person he's answering**
so it's clear who each reply is for. Because each message is tagged with the
speaker's name, the whole group can talk to him at once and he answers each
person specifically. **Only linked players may talk here** — an unlinked user's
message is deleted with a nudge to `!link` first. Two more layers keep it from
spamming: a per-user **cooldown** (`CHAT_COOLDOWN_MS`) throttles back-to-back
replies, and a rolling **budget of messages per user per hour** (default **5**,
change it live with `!chatlimit <n>`) caps the volume. Over-budget messages are
**not** deleted — Survivor just tells the user once how long until it replenishes,
then stays quiet for them until it does. (Deleting the unlinked/commands-only
messages needs the bot to have **Manage Messages** in that channel.)

He also chats **one-on-one in DMs**, but only with **linked players** and only
about **video games** — DM him anything off-topic and he'll deflect it in
character. (Unlinked users just get nudged to `!link` first.) He stays silent in
every *other* server channel.

**Where commands work:** `!` commands run in the **achievements channel**
(`ACHIEVEMENT_CHANNEL_ID`) and in **DMs**. That channel is commands-only — any
message there that doesn't start with `!` is deleted immediately to keep it tidy.
(If you leave `ACHIEVEMENT_CHANNEL_ID` blank, commands fall back to working
anywhere so the bot is still usable before setup.) Slash (`/`) commands work
anywhere as usual.

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

### The link role (Castaway)

The moment a player links a Steam account with `!link`, the bot gives them the
**🪂 Castaway** role (0 points — it sits below every milestone role). It's stripped
again on `!unlink`. Lock your survivor/achievement/voice channels to this role in
Discord's channel permissions and only linked players can join them.

- Linked from a **DM** before joining the server? The role is granted the moment
  they join (via `guildMemberAdd`).
- Players who linked **before** this feature existed get it automatically on the
  next boot (a one-time backfill).

### Milestone rewards

| Points | Reward | Discord role assigned |
| --- | --- | --- |
| linked | 🪂 Castaway | `Castaway` |
| 100 | 🎖️ Forest Rookie | `Forest Rookie` |
| 200 | 🪓 Axe Master | `Axe Master` |
| 300 | 🏠 Base Builder | `Base Builder` |
| 500 | 👑 Forest Legend | `Forest Legend` |

> Milestones at 400, 600, 700… still get a celebration announcement, just no
> dedicated role.

### Voice activity (optional)

Set **`GAME_VOICE_CHANNEL_ID`** to the voice channel your group games in and the
bot tracks how long each **linked** player spends in it. Crossing a cumulative
**hour milestone** awards bonus points (which feed the normal totals/roles) and
posts a newbie→veteran announcement in the achievement channel:

| Voice hours | Rank | Bonus points |
| --- | --- | --- |
| 1h | 🎙️ Voice Newbie | +20 |
| 5h | 🗣️ Voice Regular | +40 |
| 10h | 🔥 Voice Veteran | +75 |
| 25h | 👑 Voice Legend | +150 |

On top of those milestones, a steady **drip** pays out
`VOICE_POINTS_PER_INTERVAL` points (default **3**) for every
`VOICE_POINTS_INTERVAL_MIN` minutes (default **10**) of voice time — set
`VOICE_POINTS_PER_INTERVAL=0` to turn the drip off. When `VOICE_DRIP_ANNOUNCE` is
`true` (default), each voice session posts **one** message in the achievement
channel and edits it in place as the total climbs (`+3… +6… +9 pts this session`),
finalizing to a summary when the player leaves — so it never floods the feed. Each
player's running voice time also shows as a 🎙️ **Voice** field on their `!stats`
card.

Set **`VOICE_KICK_UNLINKED=true`** to also DM anyone who joins the channel without
a linked Steam and disconnect them after `VOICE_LINK_GRACE_SECONDS` (default 120)
if they still haven't linked. This needs the bot to have the **Move Members**
permission on that channel; it also requires the **`GuildVoiceStates`** intent,
which is already enabled in code.

> Voice time is only credited to **linked** players. Unlinked users are never
> awarded points (they're just optionally kicked).

### Counting other games (optional)

By default only **The Forest** and **Sons of the Forest** earn points. Set
**`TRACK_ALL_GAMES=true`** and the bot also checks each player's *recently-played*
games every poll and awards points for new unlocks in **any** of them (announced
with the game's name). The first time a new game is seen for a player its existing
achievements are **baselined silently** — so enabling this never dumps a whole
back-catalogue in as points; only unlocks earned afterward count.

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
   **Send Messages**, **Read Message History**, **Manage Roles**,
   **Manage Messages** (to clean the achievements/chat channels), and — if you
   use the game voice channel — **Move Members** (to kick unlinked joiners). Open
   the generated URL to invite the bot to your server.

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

Create five roles with these **exact names**:
`Castaway`, `Forest Rookie`, `Axe Master`, `Base Builder`, `Forest Legend`.

`Castaway` is the entry role given on `!link` — lock your channels to it if you
want only linked players to be able to join them.

> **Important:** drag the **bot's own role above all five** in
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

### Backing up & restoring the data

`!backup` (admin-only) DMs you two files:

- **`survivor-<timestamp>.db`** — a complete, self-contained SQLite snapshot
  (taken WAL-safe with SQLite's online backup, so it's consistent even while the
  bot is running). This is the full restore.
- **`survivor-points-<timestamp>.csv`** — a human-readable table of every player
  (Discord ID, Steam ID, name, points, streaks, voice seconds). This is the
  emergency fallback for rebuilding by hand if the `.db` is ever lost.

**To restore / continue the data on a rebuild or a fresh bot:**

1. Stop the bot.
2. Put the backed-up `.db` file where the bot reads its database — i.e. at the
   path in **`DATABASE_PATH`** (e.g. `/data/survivor.db` on Railway), or at
   `./survivor.db` locally if `DATABASE_PATH` is unset. Rename it to match.
3. Delete any stale `*.db-wal` / `*.db-shm` sidecar files next to it (the backup
   is already a single consolidated file).
4. Start the bot. Everyone's points, links, streaks, and voice hours pick up
   exactly where the backup left off, and the schema auto-migrates if the new
   build added columns.

> Because the `.db` is a normal SQLite file, you can also open it with any SQLite
> viewer to inspect or hand-edit it. Keep backups somewhere off your host so they
> survive even if the host disappears.

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

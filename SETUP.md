# ✅ Survivor Bot — Exact Setup Steps

Follow these in order. Don't skip any. By the end the bot will be running and
tracking achievements. There are **8 parts**. Budget ~30 minutes the first time.

When a step says "copy this value", paste it into a scratch text file for now —
you'll put them all into the `.env` file in **Part 6**.

You will end up collecting these values:

- `DISCORD_BOT_TOKEN`
- `STEAM_API_KEY`
- `GEMINI_API_KEY`
- `ACHIEVEMENT_CHANNEL_ID` (your announcements channel)
- `SURVIVOR_CHAT_CHANNEL_ID` (your chat channel)
- `STEAM_IDS` (optional — members can link themselves later)

---

## ⚡ First, pick how you'll run the bot

The bot's code is JavaScript, and it needs **Node.js** (a runtime) to actually
run it. *Where* Node.js lives depends on where you want the bot to run:

| Your plan | What to do |
| --- | --- |
| **Run it on your own computer** (good for testing) | Do **all 8 parts** in order. You'll install Node.js in Part 1. |
| **Run it 24/7 on Railway only** (set-and-forget) | **Skip Part 1 and Part 7** — Railway provides Node.js for you. Do Parts 2–6, then jump to Part 8. |

> 💡 Recommended for first-timers: do the local run (Part 7) once to confirm
> everything works, *then* set up Railway (Part 8) for 24/7 uptime. But if you
> just want it always-on and never touch a terminal, the Railway-only path is
> totally fine.

---

## Part 1 — Install Node.js

> ⏭️ **Going straight to Railway (Part 8)? Skip this part** — Railway runs the
> bot on its own servers and provides Node.js for you.

1. Go to <https://nodejs.org/> and download the **LTS** installer (or anything
   v18 or newer; v20+ recommended).
2. Run the installer, accept the defaults, finish.
3. Confirm it worked. Open a terminal:
   - **Windows:** press `Start`, type `powershell`, hit Enter.
   - **Mac:** open the **Terminal** app.
4. Type this and press Enter:
   ```bash
   node --version
   ```
   You should see something like `v20.x.x` or higher. If you get "command not
   found", restart your computer and try again.

---

## Part 2 — Create the Discord bot

### 2a. Make the application
1. Go to <https://discord.com/developers/applications>.
2. Click **New Application** (top right).
3. Name it `Survivor` → check the box → **Create**.

### 2b. Create the bot user and get the token
1. In the left sidebar, click **Bot**.
2. Click **Reset Token** → **Yes, do it!** → **Copy**.
   - 👉 This is your **`DISCORD_BOT_TOKEN`**. Save it now — Discord only shows it
     once. If you lose it, just hit **Reset Token** again.
   - ⚠️ Never share this token or post it anywhere public.

### 2c. Turn on the two required intents
Still on the **Bot** page, scroll down to **Privileged Gateway Intents** and turn
**ON** both of these toggles:
- ✅ **SERVER MEMBERS INTENT**
- ✅ **MESSAGE CONTENT INTENT**

Click **Save Changes** at the bottom. (If you skip this, the bot can't read
commands or assign roles.)

### 2d. Invite the bot to your server
1. Left sidebar → **OAuth2** → **URL Generator**.
2. Under **SCOPES**, check **BOTH**:
   - ✅ **`bot`**
   - ✅ **`applications.commands`**  ← needed for slash (`/`) commands to appear
3. A **BOT PERMISSIONS** box appears below. Check:
   - ✅ **Send Messages**
   - ✅ **Read Message History**
   - ✅ **Manage Roles**
4. Scroll down, copy the **Generated URL** at the bottom.
5. Paste that URL into your browser → pick your server → **Authorize** → solve
   the captcha.
6. The bot now appears in your server's member list (offline for now — that's
   normal).

> If you already invited the bot **without** `applications.commands`, just
> generate the URL again with both scopes ticked and re-authorize — the slash
> commands will show up after the bot next starts.

---

## Part 3 — Create the reward roles

The bot assigns these roles automatically, but **you must create them first**,
spelled **exactly** like this (capitalization matters):

1. In Discord, go to **Server Settings → Roles → Create Role**.
2. Create these four roles, one at a time:
   - `Forest Rookie`
   - `Axe Master`
   - `Base Builder`
   - `Forest Legend`

### ⚠️ 3b. Move the bot's role ABOVE the reward roles (critical!)
Discord only lets a bot assign roles that sit **below** its own role.

1. Still in **Server Settings → Roles**, find the bot's role. It's usually named
   `Survivor` (same as the bot) and was created automatically when you invited it.
2. **Drag it up** so it sits **above** all four reward roles in the list.
3. The order from top to bottom should look like:
   ```
   (your admin roles)
   Survivor          ← the bot's role, must be above the four below
   Forest Legend
   Base Builder
   Axe Master
   Forest Rookie
   ```
If you skip this, the bot will run but role-assignment will silently fail (you'll
see a `[roles] failed…` line in the logs).

---

## Part 4 — Get your two channel IDs

The bot uses **two separate channels**, and **you choose them.** The names don't
matter at all — only the IDs do. You can name them anything; this guide uses
`#achievement` and `#chat` as examples.

| Channel (name it whatever you want) | What the bot does there | Goes into this setting |
| --- | --- | --- |
| e.g. `#achievement` | **Posts** achievement unlocks 🏆 and milestone/reward 👑 messages | `ACHIEVEMENT_CHANNEL_ID` |
| e.g. `#chat` | **Talks with you** — replies to every message, remembers the convo | `SURVIVOR_CHAT_CHANNEL_ID` |

Survivor is **silent everywhere except these two channels** (he announces in the
first, chats in the second).

### Steps
1. In Discord, create the two channels (or reuse existing ones).
2. **User Settings (gear icon) → Advanced → Developer Mode** → turn it **ON**.
3. Right-click your **announcements** channel → **Copy Channel ID**.
   - 👉 This is your **`ACHIEVEMENT_CHANNEL_ID`**. Save it.
4. Right-click your **chat** channel → **Copy Channel ID**.
   - 👉 This is your **`SURVIVOR_CHAT_CHANNEL_ID`**. Save it.
5. Make sure the bot can **see and send messages in both** channels (it can, if
   they aren't private and the bot has Send Messages from Part 2d). If a channel
   is private, give the bot's `Survivor` role access to it.

> 💡 You can point both settings at the **same** channel if you'd rather have
> announcements and chat in one place — just paste the same ID into both. And if
> you leave `SURVIVOR_CHAT_CHANNEL_ID` blank, Survivor simply won't chat anywhere
> (announcements still work).

---

## Part 5 — Steam setup

### 5a. Get a Steam Web API key
1. Make sure you're logged into Steam in your browser.
2. Go to <https://steamcommunity.com/dev/apikey>.
3. For **Domain Name** type anything (e.g. `survivorbot`), agree to the terms,
   click **Register**.
4. Copy the **Key**.
   - 👉 This is your **`STEAM_API_KEY`**. Save it.

### 5b. Each of the 5 members must make their profile public
This is per-person. Each player does this on **their own** Steam account:
1. Steam → click your name (top right) → **Profile** → **Edit Profile**.
2. **Privacy Settings**.
3. Set **My profile** = **Public**.
4. Set **Game details** = **Public**.  ← achievements live here; this one is
   essential.
5. Save.

> If a member's profile or game details are private, the bot simply can't read
> their achievements and will skip them — no error, just no points for them.

### 5c. Collect each member's SteamID64
For each of the 5 players:
1. Go to <https://steamid.io/>.
2. Paste their Steam profile URL (or vanity name) → **lookup**.
3. Copy the **steamID64** value — it's a **17-digit number** like
   `76561197960287930`.

You can either pre-load these now (Part 6, `STEAM_IDS`) **or** have each member
run `!link <their steamid64>` in Discord after the bot is online. Either works.

---

## Part 6 — Get the Gemini API key

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key**.
3. Copy the key.
   - 👉 This is your **`GEMINI_API_KEY`**. Save it.

> The free tier is more than enough for a 5-person bot.

---

## Part 7 — Configure and run the bot (on your computer)

> ⏭️ **Going straight to Railway (Part 8)? Skip this part** — you'll set the
> same values as Railway **Variables** instead of a local `.env` file, and
> Railway runs the bot for you. (You can still do this part first if you want to
> test locally before hosting.)

1. Open a terminal **in the bot's folder**. Easiest way:
   - **Windows:** open the `discordbot` folder in File Explorer, click the
     address bar, type `powershell`, press Enter.
   - **Mac:** right-click the folder → **New Terminal at Folder** (or `cd` into it).

2. Create your config file from the template:
   - **Windows (PowerShell):**
     ```powershell
     Copy-Item .env.example .env
     ```
   - **Mac/Linux:**
     ```bash
     cp .env.example .env
     ```

3. Open the new `.env` file in any text editor (Notepad is fine) and fill in your
   saved values. It should look like this (with your real values):
   ```env
   DISCORD_BOT_TOKEN=MT234...your-token...
   STEAM_API_KEY=ABCD1234...
   GEMINI_API_KEY=AIzaSy...
   ACHIEVEMENT_CHANNEL_ID=111111111111111111
   SURVIVOR_CHAT_CHANNEL_ID=222222222222222222
   STEAM_IDS=111111111111111111:76561197960287930,222222222222222222:76561198000000000
   ```
   - For `STEAM_IDS`, each entry is `DiscordUserID:SteamID64`, separated by
     commas. **Leave it blank** if you'd rather everyone use `/link` instead.
   - To get a member's **Discord User ID**: with Developer Mode on (Part 4),
     right-click their name → **Copy User ID**.
   - **Optional features** (now-playing pings, weekly recap, counting existing
     achievements, etc.) have their own settings at the bottom of
     `.env.example`, each with a comment explaining it. They're all off by
     default — turn on the ones you want.

4. Install the bot's dependencies (only needed once):
   ```bash
   npm install
   ```

5. Start the bot:
   ```bash
   node index.js
   ```

6. Success looks like this in the terminal:
   ```
   ✅ Survivor is awake as Survivor#1234
   ⏱️  Polling Steam every 300s
   ```
   The bot now shows **online** in Discord.

7. Test it: type `!leaderboard` and `!survey` in any channel the bot can see.

> **Note on the first run:** the very first time the bot checks a player, it
> records the achievements they *already* have **silently** (no points, no
> announcements) so you don't get flooded. Only achievements unlocked **after
> this point** earn points. Unlock something new and within 5 minutes you'll see
> the announcement in `#achievements`.

To stop the bot, press `Ctrl + C` in the terminal. (When the terminal is closed,
the bot stops — that's why you'll want Part 8 for 24/7 uptime.)

---

## Part 8 — (Optional) Host it free on Railway for 24/7 uptime

Running on your computer only works while the terminal is open. Railway keeps the
bot online all the time.

### 8a. Put the code on GitHub
1. Create a free account at <https://github.com>.
2. Create a **new repository** (it can be **Private**).
3. Upload this whole project folder to it.
   - The included `.gitignore` already prevents `.env`, `node_modules/`, and the
     database file from being uploaded — **good, your secrets stay out of GitHub.**
   - Easiest no-command-line way: on the new repo page, click
     **uploading an existing file** and drag in everything **except** the
     `node_modules` folder and your `.env` file.

### 8b. Deploy on Railway
1. Go to <https://railway.app> and sign up (you can sign in with GitHub).
2. **New Project → Deploy from GitHub repo** → authorize → pick your repo.
3. Railway auto-detects Node.js and runs `npm install` then `npm start`
   (already configured in `package.json`). Let it build.

### 8c. Add your secrets as Variables
1. Click your service → **Variables** tab → **New Variable** (or **Raw Editor**).
2. Add each one (same values as your local `.env`):
   - `DISCORD_BOT_TOKEN`
   - `STEAM_API_KEY`
   - `GEMINI_API_KEY`
   - `ACHIEVEMENT_CHANNEL_ID`
   - `SURVIVOR_CHAT_CHANNEL_ID`
   - `STEAM_IDS` (optional)
   - Optional feature toggles (see `.env.example`): `NOW_PLAYING_ENABLED`,
     `RECAP_ENABLED`, `BACKFILL_EXISTING`, `LOG_CHANNEL_ID`, `CHAT_COOLDOWN_MS`
3. Railway redeploys automatically. Open the **Deploy Logs** and wait for
   `✅ Survivor is awake`.

### 8d. (Recommended) Keep points between redeploys
Railway wipes the local disk on every redeploy, which would reset everyone's
points. To prevent that:
1. Service → **Settings → Volumes → New Volume**.
2. Mount it at `/app`.
3. Now `survivor.db` persists across deploys.

Done — the bot now runs 24/7 and survives restarts.

---

## Quick troubleshooting

| Symptom | Fix |
| --- | --- |
| `❌ Missing required environment variable` on start | A value in `.env` (or Railway Variables) is blank or misspelled. |
| Bot is online but ignores `!points` / mentions | You didn't enable **MESSAGE CONTENT INTENT** (Part 2c). |
| Achievements never announce | Member's Steam **Game details** isn't Public (5b), wrong SteamID64, or they don't own The Forest on that account. |
| Roles aren't given out | Bot's role isn't **above** the reward roles, or it lacks **Manage Roles** (Parts 2d & 3b). Check logs for `[roles] failed…`. |
| Survivor won't chat at all | `SURVIVOR_CHAT_CHANNEL_ID` is blank or is the wrong channel ID (Part 4). Startup log shows which channel he's locked to. He only talks in that one channel. |
| Survivor replies are generic/canned | `GEMINI_API_KEY` is missing or invalid. Announcements still post; check logs for `[survivor] Gemini API error`. |
| Bot offline after closing terminal | Expected when running locally — do Part 8 (Railway) for 24/7 uptime. |

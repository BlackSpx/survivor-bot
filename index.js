// Survivor — Discord bot for a small The Forest friend group.
// Tracks Steam achievements (The Forest + Sons of the Forest), awards points,
// assigns reward roles, chats in a locked channel, and more.

import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} from 'discord.js';

import * as db from './src/db.js';
import {
  getPlayerAchievements,
  getPlayerSummary,
  getGlobalAchievementPct,
  probeAchievementAccess,
} from './src/steam.js';
import * as survivor from './src/survivor.js';
import * as health from './src/health.js';
import { REWARDS, milestonesCrossed, rewardForPoints, rarityTier } from './src/rewards.js';
import { TRACKED_APP_IDS, gameName } from './src/games.js';

const {
  DISCORD_BOT_TOKEN,
  ACHIEVEMENT_CHANNEL_ID,
  SURVIVOR_CHAT_CHANNEL_ID = '',
  LOG_CHANNEL_ID = '',
  STEAM_IDS = '',
  POLL_INTERVAL_MS = '300000',
  CHAT_COOLDOWN_MS = '4000',
  NOW_PLAYING_ENABLED = 'false',
  RECAP_ENABLED = 'false',
  BACKFILL_EXISTING = 'false',
  OWNER_DISCORD_ID = '',
  OWNER_PING = 'false',
  ADMIN_DISCORD_IDS = '',
} = process.env;

// Who may run admin commands (!backup, !addpoints, !setpoints). If ADMIN_DISCORD_IDS
// (or OWNER_DISCORD_ID) is set, ONLY those exact Discord user IDs qualify — server
// "Administrator" permission no longer counts. If neither is set, we fall back to
// the Administrator permission so the bot isn't accidentally locked before setup.
const ADMIN_IDS = (ADMIN_DISCORD_IDS || OWNER_DISCORD_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const POINTS_PER_ACHIEVEMENT = 10;
const FIRST_BLOOD_BONUS = 15; // first in the group to unlock an achievement
const STREAK_BONUS_PER_DAY = 2; // bonus per day of an active unlock streak...
const STREAK_BONUS_MAX = 20; // ...capped here so streaks can't run away
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const NOW_PLAYING_MIN_GAP_MS = 2 * 60 * 60 * 1000; // don't re-announce within 2h

const nowPlayingOn = NOW_PLAYING_ENABLED === 'true';
const recapOn = RECAP_ENABLED === 'true';
const backfillOn = BACKFILL_EXISTING === 'true';

// ── Startup checks ───────────────────────────────────────────────────────────

for (const key of [
  'DISCORD_BOT_TOKEN',
  'STEAM_API_KEY',
  'GEMINI_API_KEY',
]) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ACHIEVEMENT_CHANNEL_ID is optional: without it, achievement/milestone posts
// are skipped (all sends are guarded), but DMs and chat still work.
if (!ACHIEVEMENT_CHANNEL_ID) {
  console.warn('⚠️  No ACHIEVEMENT_CHANNEL_ID set — achievement posts disabled (DMs/chat still work).');
}

function seedFromEnv() {
  if (!STEAM_IDS.trim()) return;
  for (const pair of STEAM_IDS.split(',')) {
    const [discordId, steamId] = pair.split(':').map((s) => s?.trim());
    if (discordId && steamId) {
      db.linkPlayer(discordId, steamId);
      console.log(`[seed] linked ${discordId} → ${steamId}`);
    } else {
      console.warn(`[seed] ignoring malformed STEAM_IDS entry: "${pair}"`);
    }
  }
}

// ── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

async function fetchChannel(id) {
  if (!id) return null;
  try {
    return await client.channels.fetch(id);
  } catch (err) {
    console.error(`[discord] could not fetch channel ${id}: ${err.message}`);
    return null;
  }
}

const getAchievementChannel = () => fetchChannel(ACHIEVEMENT_CHANNEL_ID);

async function displayName(player) {
  if (player?.steam_name) return player.steam_name;
  try {
    const user = await client.users.fetch(player.discord_id);
    return user.username;
  } catch {
    return player.discord_id;
  }
}

async function assignRole(discordId, roleName) {
  for (const guild of client.guilds.cache.values()) {
    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (!role) continue;
    let member;
    try {
      member = await guild.members.fetch(discordId);
    } catch {
      continue;
    }
    if (member.roles.cache.has(role.id)) continue;
    try {
      await member.roles.add(role);
      console.log(`[roles] gave "${roleName}" to ${discordId}`);
    } catch (err) {
      console.warn(
        `[roles] failed to give "${roleName}" to ${discordId}: ${err.message}. ` +
          `Check the bot's role is ABOVE "${roleName}" and it has Manage Roles.`
      );
    }
  }
}

/** Assign every reward role the player qualifies for at their current points. */
async function assignRolesUpTo(discordId, points) {
  for (const reward of REWARDS) {
    if (points >= reward.points) await assignRole(discordId, reward.role);
  }
}

// ── Achievement polling ──────────────────────────────────────────────────────

const nowPlayingState = new Map(); // steamId -> { playing, lastAnnounce }

async function handleNowPlaying(player, summary, channel) {
  const appId = summary.gameId;
  const playingTracked = appId != null && TRACKED_APP_IDS.includes(String(appId));
  const st = nowPlayingState.get(player.steam_id) ?? { playing: false, lastAnnounce: 0 };

  if (playingTracked && !st.playing && Date.now() - st.lastAnnounce > NOW_PLAYING_MIN_GAP_MS) {
    const name = await displayName(player);
    const line = await survivor.commentNowPlaying(name, gameName(String(appId)));
    if (channel) await channel.send(`🎮 ${line}`);
    st.lastAnnounce = Date.now();
  }

  st.playing = playingTracked;
  nowPlayingState.set(player.steam_id, st);
}

async function pollPlayer(player, channel) {
  // One summary call per player: refreshes name + drives "now playing".
  const summary = await getPlayerSummary(player.steam_id);
  if (summary?.personaname && !player.steam_name) {
    db.setSteamName(player.discord_id, summary.personaname);
    player.steam_name = summary.personaname;
  }
  if (nowPlayingOn && summary) await handleNowPlaying(player, summary, channel);

  // First time we ever poll this player: baseline or backfill.
  if (!player.seeded) {
    await seedPlayer(player, channel);
    return;
  }

  // Normal path: detect newly-unlocked achievements across all tracked games.
  const name = await displayName(player);
  for (const appId of TRACKED_APP_IDS) {
    const achievements = await getPlayerAchievements(player.steam_id, appId);
    if (!achievements) continue;
    const rarityMap = await getGlobalAchievementPct(appId); // may be null

    for (const ach of achievements) {
      if (!ach.achieved) continue;
      if (db.hasAchievement(player.discord_id, appId, ach.apiname)) continue;

      // Bonuses (checked BEFORE recording, so first-blood sees a clean slate).
      const firstBlood = db.achievementOwnerCount(appId, ach.apiname) === 0;
      const pct = rarityMap?.get(ach.apiname);
      const rarity = rarityTier(pct);

      db.recordAchievement(
        player.discord_id,
        appId,
        ach.apiname,
        ach.displayName,
        ach.unlockTime,
        1 // awarded
      );

      const streak = db.recordUnlockDay(player.discord_id, Math.floor(Date.now() / DAY_MS));
      const streakBonus = Math.min((streak.current - 1) * STREAK_BONUS_PER_DAY, STREAK_BONUS_MAX);
      const firstBloodBonus = firstBlood ? FIRST_BLOOD_BONUS : 0;
      const rarityBonus = rarity?.bonus ?? 0;
      const gained = POINTS_PER_ACHIEVEMENT + firstBloodBonus + rarityBonus + Math.max(0, streakBonus);

      const before = db.getPlayer(player.discord_id).points;
      const after = db.addPoints(player.discord_id, gained);
      await announceAchievement(channel, name, ach.displayName, gameName(appId), after, {
        gained,
        firstBloodBonus,
        rarity,
        rarityPct: pct,
        rarityBonus,
        streak,
        streakBonus: Math.max(0, streakBonus),
      });
      await handleMilestones(channel, player.discord_id, name, before, after);
    }
  }
}

async function seedPlayer(player, channel) {
  let existing = 0;
  for (const appId of TRACKED_APP_IDS) {
    const achievements = await getPlayerAchievements(player.steam_id, appId);
    if (!achievements) continue;
    for (const ach of achievements) {
      if (!ach.achieved) continue;
      // awarded = backfill ? 1 : 0
      db.recordAchievement(
        player.discord_id,
        appId,
        ach.apiname,
        ach.displayName,
        ach.unlockTime,
        backfillOn ? 1 : 0
      );
      existing += 1;
    }
  }

  db.markSeeded(player.discord_id);

  if (backfillOn && existing > 0) {
    const points = existing * POINTS_PER_ACHIEVEMENT;
    const total = db.addPoints(player.discord_id, points);
    const name = await displayName(player);
    await assignRolesUpTo(player.discord_id, total);

    const line = await survivor.backfillWelcome(name, existing, points);
    const earned = REWARDS.filter((r) => total >= r.points)
      .map((r) => `${r.emoji} ${r.name}`)
      .join(', ');
    const embed = new EmbedBuilder()
      .setColor(0x8bc34a)
      .setDescription(
        `🎒 Counted **${name}**'s **${existing}** existing achievements → ` +
          `**+${points} pts** (total: **${total}**)\n\n${line}` +
          (earned ? `\n\n🏅 Roles unlocked: ${earned}` : '')
      );
    if (channel) await channel.send({ embeds: [embed] });
    console.log(`[poll] backfilled ${player.discord_id}: +${points} pts`);
  } else {
    console.log(`[poll] baselined ${player.discord_id} (${existing} achievements, no points)`);
  }
}

async function announceAchievement(channel, name, achievementName, game, total, award) {
  const comment = await survivor.commentOnAchievement(name, achievementName);

  const bonusLines = [];
  if (award.firstBloodBonus) {
    bonusLines.push(`🩸 **First Blood!** First in the group to grab this — +${award.firstBloodBonus}`);
  }
  if (award.rarity) {
    const pctText = award.rarityPct != null ? ` · only ${award.rarityPct.toFixed(1)}% have it` : '';
    bonusLines.push(`${award.rarity.emoji} **${award.rarity.label}**${pctText} — +${award.rarityBonus}`);
  }
  if (award.streakBonus > 0) {
    bonusLines.push(`🔥 **${award.streak.current}-day streak** — +${award.streakBonus}`);
  }
  const breakdown = bonusLines.length ? `\n${bonusLines.join('\n')}` : '';

  const embed = new EmbedBuilder()
    .setColor(award.firstBloodBonus ? 0xe53935 : 0x4caf50)
    .setDescription(
      `🏆 **${name}** just unlocked "**${achievementName}**"! _(${game})_\n\n` +
        `${comment}\n` +
        breakdown +
        `\n\n**+${award.gained} pts** | Total: **${total} pts**`
    );
  if (channel) await channel.send({ embeds: [embed] });
}

async function handleMilestones(channel, discordId, name, before, after) {
  for (const milestone of milestonesCrossed(before, after)) {
    const reward = rewardForPoints(milestone);
    const rewardLabel = reward
      ? `${reward.emoji} "${reward.name}" role`
      : '🎉 Bragging rights (and a slightly longer life expectancy)';

    const celebration = await survivor.celebrateMilestone(
      name,
      milestone,
      reward ? reward.name : 'survival'
    );

    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setDescription(
        `👑 **${name}** hit **${milestone}** points!\n\n` +
          `${celebration}\n\n` +
          `🎁 Reward: ${rewardLabel}`
      );
    if (channel) await channel.send({ embeds: [embed] });

    if (reward) await assignRole(discordId, reward.role);
    db.setLastMilestone(discordId, milestone);
  }
}

async function pollAllPlayers() {
  const players = db.getLinkedPlayers();
  if (players.length === 0) return;
  const channel = await getAchievementChannel();
  for (const player of players) {
    try {
      await pollPlayer(player, channel);
    } catch (err) {
      console.error(`[poll] error for ${player.discord_id}: ${err.message}`);
    }
  }
}

// ── Weekly recap ─────────────────────────────────────────────────────────────

async function postWeeklyRecap() {
  const stats = db.getStatsSince(Date.now() - WEEK_MS);
  const channel = await getAchievementChannel();
  if (!channel) return;

  if (stats.length === 0) {
    await channel.send(
      "📅 **Weekly Recap** — nobody unlocked anything this week. The forest claims another lazy bunch."
    );
    return;
  }

  const lines = [];
  let topName = null;
  for (const row of stats) {
    const player = db.getPlayer(row.discord_id);
    const name = player ? await displayName(player) : row.discord_id;
    if (!topName) topName = name;
    lines.push(`**${name}** — ${row.count} achievement${row.count === 1 ? '' : 's'} (+${row.count * POINTS_PER_ACHIEVEMENT} pts)`);
  }

  const intro = await survivor.weeklyRecapIntro(topName);
  const embed = new EmbedBuilder()
    .setColor(0xff9800)
    .setTitle('📅 Weekly Recap')
    .setDescription(`${intro}\n\n${lines.join('\n')}`);
  await channel.send({ embeds: [embed] });
}

function startRecapScheduler() {
  if (!recapOn) return;
  if (!db.getMeta('last_recap_at')) db.setMeta('last_recap_at', Date.now());
  setInterval(async () => {
    const last = Number(db.getMeta('last_recap_at') || Date.now());
    if (Date.now() - last >= WEEK_MS) {
      try {
        await postWeeklyRecap();
      } catch (err) {
        console.error(`[recap] error: ${err.message}`);
      }
      db.setMeta('last_recap_at', Date.now());
    }
  }, 60 * 60 * 1000); // check hourly
  console.log('🗓️  Weekly recap enabled (posts ~every 7 days).');
}

// ── Conversation (locked channel) ────────────────────────────────────────────

const conversations = new Map(); // channelId -> [{ role, parts:[{text}] }]
const chatCooldowns = new Map(); // userId -> timestamp
const MAX_HISTORY = 16;
const cooldownMs = Number(CHAT_COOLDOWN_MS) || 4000;

function getHistory(channelId) {
  if (!conversations.has(channelId)) conversations.set(channelId, []);
  return conversations.get(channelId);
}

function trimHistory(history) {
  while (history.length > MAX_HISTORY) history.shift();
  while (history.length && history[0].role === 'model') history.shift();
}

function loadChatHistory() {
  if (!SURVIVOR_CHAT_CHANNEL_ID) return;
  const rows = db.getRecentChat(SURVIVOR_CHAT_CHANNEL_ID, MAX_HISTORY);
  const history = getHistory(SURVIVOR_CHAT_CHANNEL_ID);
  for (const r of rows) history.push({ role: r.role, parts: [{ text: r.content }] });
  trimHistory(history);
  if (rows.length) console.log(`[chat] restored ${rows.length} remembered messages`);
}

function onCooldown(userId) {
  const last = chatCooldowns.get(userId) ?? 0;
  if (Date.now() - last < cooldownMs) return true;
  chatCooldowns.set(userId, Date.now());
  return false;
}

// Rolling per-user message budget for the chat channel: each user may send up to
// CHAT_BUDGET messages per CHAT_BUDGET_WINDOW_MS. In-memory by design — a restart
// forgives everyone, and a rolling window needs no daily-reset bookkeeping.
const CHAT_BUDGET = 5;
const CHAT_BUDGET_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const chatBudget = new Map(); // userId -> [timestamps within the window]

/**
 * Try to spend one message from a user's rolling budget.
 * Returns { allowed:true } if there was room (and records the message), or
 * { allowed:false, retryMinutes } if they're already at the cap.
 */
function spendChatBudget(userId) {
  const now = Date.now();
  const recent = (chatBudget.get(userId) ?? []).filter((t) => now - t < CHAT_BUDGET_WINDOW_MS);
  if (recent.length >= CHAT_BUDGET) {
    chatBudget.set(userId, recent); // keep the pruned list
    const retryMinutes = Math.max(1, Math.ceil((CHAT_BUDGET_WINDOW_MS - (now - recent[0])) / 60000));
    return { allowed: false, retryMinutes };
  }
  recent.push(now);
  chatBudget.set(userId, recent);
  return { allowed: true };
}

/**
 * Delete an offending message and drop a brief notice that cleans itself up, so
 * the channel doesn't fill with bot scolding. Needs the "Manage Messages"
 * permission to delete — warns (doesn't crash) if it's missing.
 */
async function deleteAndNotify(message, text) {
  try {
    await message.delete();
  } catch (err) {
    console.warn(
      `[moderation] couldn't delete a message in ${message.channel.id}: ${err.message}. ` +
        `Give the bot the "Manage Messages" permission in that channel.`
    );
  }
  try {
    const notice = await message.channel.send({
      content: text,
      allowedMentions: { users: [message.author.id] },
    });
    setTimeout(() => notice.delete().catch(() => {}), 8000);
  } catch {
    /* sending the notice is best-effort */
  }
}

async function converse(message, { dm = false } = {}) {
  const channelId = message.channel.id;
  const history = getHistory(channelId);
  // Lazily restore remembered messages (e.g. DM channels not preloaded at boot).
  if (history.length === 0) {
    const rows = db.getRecentChat(channelId, MAX_HISTORY);
    for (const r of rows) history.push({ role: r.role, parts: [{ text: r.content }] });
    trimHistory(history);
  }
  const name = message.member?.displayName ?? message.author.username;
  const text = message.content.replace(/<@!?\d+>/g, '').trim() || 'hi';

  const userLine = `${name}: ${text}`;
  history.push({ role: 'user', parts: [{ text: userLine }] });
  trimHistory(history);
  db.appendChat(channelId, 'user', userLine);

  const reply = dm ? await survivor.chatDM(history) : await survivor.chat(history);

  history.push({ role: 'model', parts: [{ text: reply }] });
  trimHistory(history);
  db.appendChat(channelId, 'model', reply);
  db.trimChat(channelId, 50);

  // Render any owner mention as a clickable link without pinging people on every
  // reply. Set OWNER_PING=true to actually ping the owner when they're named.
  const allowedMentions =
    OWNER_PING === 'true' && OWNER_DISCORD_ID
      ? { users: [OWNER_DISCORD_ID], repliedUser: true }
      : { parse: [], repliedUser: true };
  await message.reply({ content: reply, allowedMentions });
}

// ── Command logic (shared by ! prefix and / slash commands) ──────────────────

function payloadHelp(isAdminUser = false) {
  const lines = [
    '🌲 **Survivor** tracks your **The Forest** & **Sons of the Forest** achievements,',
    'turns them into points, ranks a leaderboard, and roasts you the whole way.',
    'Every command works as `!cmd` **or** `/cmd`, anywhere — even in my DMs.',
    '',
    '**🚀 Getting started**',
    '`!link <steamid64>` — link your Steam (find it at https://steamid.io/)',
    '> Your Steam profile + *Game details* must be Public, or I can\'t see your unlocks.',
    '> One Steam per person — `!unlink` first if you ever need to switch accounts.',
    '`!link @user` — see who someone else has linked',
    '',
    '**📊 See how you\'re doing**',
    '`!stats [@user]` — your survivor card (points, streak, rank role)',
    '`!rank` — your spot on the board + who\'s ahead of you',
    '`!points` — just your point total',
    '`!leaderboard` — everyone ranked by points',
    '`!progress [@user]` — achievement completion % per game',
    '`!achievements [@user]` — list everything unlocked',
    '',
    '**🎉 For fun**',
    '`!survey` — I ask the group a random (unhinged) question',
    '`!unlink` — remove your Steam link (your points stay)',
    '`!help` — this list',
    '',
    '**💰 How points work**',
    `> +${POINTS_PER_ACHIEVEMENT} per achievement · 🩸 +${FIRST_BLOOD_BONUS} for being first in the group to grab one · ` +
      `💎 rarity bonus for hard ones · 🔥 streak bonus for unlocking on back-to-back days.`,
  ];
  if (isAdminUser) {
    lines.push(
      '',
      '**🔒 Admin only**',
      '`!addpoints @user <n>` — add points (negative to subtract)',
      '`!setpoints @user <n>` — set a point total',
      '`!backup` — DM yourself a full database backup (+ readable CSV)'
    );
  }
  return { content: lines.join('\n') };
}

function progressBar(pct) {
  const filled = Math.round(pct / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

async function payloadPoints(userId, username) {
  const player = db.getPlayer(userId);
  const points = player?.points ?? 0;
  return {
    content:
      `🪵 **${username}**, you have **${points}** points.` +
      (player?.steam_id ? '' : ' (Link your Steam with `/link` to start earning.)'),
  };
}

async function payloadLeaderboard() {
  const players = db.getLeaderboard();
  if (players.length === 0) {
    return { content: 'Nobody has any points yet. The forest is quiet... too quiet.' };
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = await Promise.all(
    players.map(async (p, i) => {
      const name = await displayName(p);
      const rank = medals[i] ?? `**${i + 1}.**`;
      return `${rank} ${name} — **${p.points}** pts`;
    })
  );
  const embed = new EmbedBuilder()
    .setColor(0x8bc34a)
    .setTitle('🌲 Forest Leaderboard')
    .setDescription(lines.join('\n'));
  return { embeds: [embed] };
}

async function payloadAchievements(user) {
  const rows = db.getAchievements(user.id);
  if (rows.length === 0) {
    return { content: `${user.username} hasn't unlocked anything yet. Rough.` };
  }
  const list = rows
    .map((a) => `• ${a.display_name}${a.game_id ? ` _(${gameName(a.game_id)})_` : ''}`)
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(0x4caf50)
    .setTitle(`🏆 ${user.username}'s Achievements (${rows.length})`)
    .setDescription(list.slice(0, 4000));
  return { embeds: [embed] };
}

async function payloadProgress(user) {
  const player = db.getPlayer(user.id);
  if (!player?.steam_id) {
    return { content: `${user.username} hasn't linked a Steam account yet (\`/link\`).` };
  }
  const lines = [];
  let doneTotal = 0;
  let allTotal = 0;
  for (const appId of TRACKED_APP_IDS) {
    const achs = await getPlayerAchievements(player.steam_id, appId);
    if (!achs || achs.length === 0) continue;
    const done = achs.filter((a) => a.achieved).length;
    const total = achs.length;
    doneTotal += done;
    allTotal += total;
    const pct = Math.round((done / total) * 100);
    lines.push(`**${gameName(appId)}** — ${done}/${total} (${pct}%)\n${progressBar(pct)}`);
  }
  if (lines.length === 0) {
    return {
      content: `Couldn't read ${user.username}'s achievements — profile/game details may be private, or they don't own the games.`,
    };
  }
  const overall = Math.round((doneTotal / allTotal) * 100);
  const embed = new EmbedBuilder()
    .setColor(0x4caf50)
    .setTitle(`📊 ${user.username}'s Progress — ${overall}% overall`)
    .setDescription(lines.join('\n\n'));
  return { embeds: [embed] };
}

async function payloadRank(userId, username) {
  const board = db.getLeaderboard();
  const idx = board.findIndex((p) => p.discord_id === userId);
  if (idx === -1) {
    return {
      content: `You're not on the board yet, **${username}**. Run \`!link <steamid64>\` and unlock something to climb on.`,
    };
  }
  const me = board[idx];
  let line = `🪵 **${username}** — rank **#${idx + 1}** of ${board.length} with **${me.points}** pts.`;
  if (idx === 0) {
    line += board.length > 1 ? ' You\'re on top of the food chain. 👑' : ' ...though you\'re the only one here.';
  } else {
    const above = board[idx - 1];
    const aboveName = await displayName(above);
    const gap = above.points - me.points;
    line +=
      gap === 0
        ? ` Dead tied with **${aboveName}** — unlock something to break it.`
        : ` **${gap}** pt${gap === 1 ? '' : 's'} behind **${aboveName}**.`;
  }
  return { content: line };
}

// Each reward tier gets its own card color so a glance at the embed tells you
// roughly how far along someone is. Falls back to a muted slate for the unranked.
const ROLE_COLORS = {
  'Forest Rookie': 0x8bc34a,
  'Axe Master': 0x03a9f4,
  'Base Builder': 0xff9800,
  'Forest Legend': 0xffd700,
};
const NO_ROLE_COLOR = 0x607d8b;

async function payloadStats(user) {
  const player = db.getPlayer(user.id);
  if (!player) {
    return { content: `${user.username} isn't on the board yet — \`!link <steamid64>\` to join the hunt.` };
  }
  const achs = db.getAchievements(user.id);
  const board = db.getLeaderboard();
  const rank = board.findIndex((p) => p.discord_id === user.id) + 1;
  const role = [...REWARDS].reverse().find((r) => player.points >= r.points);
  const nextRole = REWARDS.find((r) => player.points < r.points);
  const streak = player.current_streak || 0;

  // Pull the Steam profile (avatar + URL) and live per-game completion. All
  // best-effort: a private/unreachable profile just means a leaner card.
  let avatar = null;
  let profileUrl = null;
  const progressLines = [];
  if (player.steam_id) {
    const summary = await getPlayerSummary(player.steam_id);
    avatar = summary?.avatar ?? null;
    profileUrl = summary?.profileUrl ?? null;
    for (const appId of TRACKED_APP_IDS) {
      const list = await getPlayerAchievements(player.steam_id, appId);
      if (!list || list.length === 0) continue;
      const done = list.filter((a) => a.achieved).length;
      const pct = Math.round((done / list.length) * 100);
      progressLines.push(`**${gameName(appId)}**  ${progressBar(pct)}  ${pct}%  _(${done}/${list.length})_`);
    }
  }

  const name = player.steam_name || user.username;
  const embed = new EmbedBuilder()
    .setColor(role ? ROLE_COLORS[role.name] ?? NO_ROLE_COLOR : NO_ROLE_COLOR)
    .setAuthor({ name: `${name} — Survivor Card`, ...(avatar ? { iconURL: avatar } : {}) });
  if (avatar) embed.setThumbnail(avatar);
  if (profileUrl) embed.setURL(profileUrl);

  embed.addFields(
    { name: '🪵 Points', value: `**${player.points}**`, inline: true },
    { name: '🏅 Rank', value: rank ? `#${rank} of ${board.length}` : '—', inline: true },
    { name: '🔥 Streak', value: `${streak}d · best ${player.best_streak || 0}`, inline: true },
    { name: '🎖️ Rank role', value: role ? `${role.emoji} ${role.name}` : '— none yet', inline: true },
    {
      name: '🎯 Next role',
      value: nextRole
        ? `${nextRole.emoji} ${nextRole.name}\n+${nextRole.points - player.points} pts to go`
        : '👑 Maxed out',
      inline: true,
    }
  );

  if (progressLines.length) {
    embed.addFields({ name: '🌲 Game progress', value: progressLines.join('\n') });
  } else if (!player.steam_id) {
    embed.addFields({
      name: '⚠️ No Steam linked',
      value: '`!link <steamid64>` to start earning points.',
    });
  } else {
    embed.addFields({ name: '🏆 Achievements tracked', value: `${achs.length}` });
  }

  return { embeds: [embed] };
}

// Public lookup: "!link @user" (a mention instead of a SteamID) shows who that
// player has linked. Anyone can run it — it's read-only.
async function payloadWhois(user) {
  const player = db.getPlayer(user.id);
  if (!player?.steam_id) {
    return { content: `🔍 **${user.username}** hasn't linked a Steam account yet.` };
  }
  const summary = await getPlayerSummary(player.steam_id);
  const steamName = player.steam_name || summary?.personaname || player.steam_id;
  const url = summary?.profileUrl;
  return {
    content:
      `🔗 **${user.username}** is linked to Steam **${steamName}** — **${player.points}** pts.` +
      (url ? `\n${url}` : ` (\`${player.steam_id}\`)`),
  };
}

async function payloadSurvey() {
  const question = await survivor.askGroupQuestion();
  return { content: `📋 **Survivor's question of the day:**\n${question}` };
}

// Steam privacy fix — shown when we link someone but can't read their unlocks.
const STEAM_PRIVACY_STEPS = [
  '**1.** Steam → your name (top-right) → **Profile** → **Edit Profile**',
  '**2.** **Privacy Settings**',
  '**3.** Set **My profile** → Public, and **Game details** → Public',
  '**4.** **Save** (Game details is the one that hides achievements).',
].join('\n');

async function actionLink(userId, username, steamId) {
  if (!steamId || !/^\d{17}$/.test(steamId)) {
    return {
      content:
        'That needs to be a 17-digit SteamID64. Find yours at https://steamid.io/',
    };
  }
  // One Discord = one Steam, for keeps. If you already have a *different* Steam
  // linked, you have to let go of it first — no quietly swapping accounts to
  // farm a second head start. (Re-running !link with the SAME id is fine.)
  const me = db.getPlayer(userId);
  if (me?.steam_id && me.steam_id !== steamId) {
    const current = me.steam_name ? `**${me.steam_name}** (${me.steam_id})` : `**${me.steam_id}**`;
    return {
      content:
        `🪢 You're already linked to ${current}. You only get one Steam link — ` +
        `run \`!unlink\` first if you really need to switch accounts.`,
    };
  }
  const owner = db.getPlayerBySteamId(steamId);
  if (owner && owner.discord_id !== userId) {
    return {
      content:
        `That Steam account is already linked to <@${owner.discord_id}>. ` +
        `Each Steam ID can only belong to one player — if it's really yours, ` +
        `have them unlink first. (One Discord = one Steam.)`,
    };
  }
  // Don't save a link we can't actually read. A private profile would link fine
  // but silently earn nothing — so refuse, explain the fix, and let them re-run
  // !link once it's public.
  if ((await probeAchievementAccess(steamId)) === 'private') {
    return {
      content:
        `🙈 Couldn't link **${username}** — your Steam profile is **private**, so I ` +
        `can't see your achievements. Fix that, then run \`!link ${steamId}\` again:\n\n` +
        STEAM_PRIVACY_STEPS,
    };
  }

  db.linkPlayer(userId, steamId);
  const summary = await getPlayerSummary(steamId);
  if (summary?.personaname) db.setSteamName(userId, summary.personaname);
  const named = summary?.personaname ? ` account **${summary.personaname}**` : '';
  return {
    content:
      `🔗 Linked **${username}** to Steam${named}. ` +
      `Go unlock something — I'm watching. Try \`!stats\` to see your card or \`!help\` for everything.`,
  };
}

function actionUnlink(userId, username) {
  const player = db.getPlayer(userId);
  if (!player?.steam_id) {
    return { content: `**${username}**, you don't have a Steam account linked.` };
  }
  db.unlinkPlayer(userId);
  return {
    content:
      `🔌 Unlinked **${username}** from Steam. Your points stay put — ` +
      `run \`!link <steamid64>\` whenever you want back in.`,
  };
}

async function actionAdjustPoints({ targetId, targetName, mode, amount }) {
  if (!Number.isInteger(amount)) {
    return { content: 'Give me a whole number of points.' };
  }
  db.ensurePlayer(targetId);
  const before = db.getPlayer(targetId).points;
  const after = mode === 'set' ? db.setPoints(targetId, amount) : db.addPoints(targetId, amount);

  // If the total went up across a milestone, announce + assign roles.
  if (after > before) {
    const channel = await getAchievementChannel();
    await handleMilestones(channel, targetId, targetName, before, after);
  }
  await assignRolesUpTo(targetId, after);

  const verb = mode === 'set' ? 'set to' : `${amount >= 0 ? 'gave' : 'took'} ${Math.abs(amount)}, now`;
  return { content: `✅ **${targetName}**'s points ${verb} **${after}**.` };
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a WAL-safe full DB backup plus a readable CSV of every player, and DM
 * both files to the requesting admin. The .db restores everything exactly; the
 * CSV is the emergency fallback (points/streaks/links per Steam ID) in case the
 * binary file is ever lost or corrupted. Returns a channel-safe status payload.
 */
async function actionBackup(user) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const tmpDb = path.join(os.tmpdir(), `survivor-backup-${stamp}.db`);
  try {
    await db.backupDatabase(tmpDb);

    const players = db.exportPlayers();
    const header = 'discord_id,steam_id,steam_name,points,current_streak,best_streak,last_milestone';
    const rows = players.map((p) =>
      [p.discord_id, p.steam_id, p.steam_name, p.points, p.current_streak, p.best_streak, p.last_milestone]
        .map(csvCell)
        .join(',')
    );
    const csv = [header, ...rows].join('\n');

    const files = [
      new AttachmentBuilder(tmpDb, { name: `survivor-${stamp}.db` }),
      new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `survivor-points-${stamp}.csv` }),
    ];

    try {
      await user.send({
        content:
          `🗄️ **Backup** — ${players.length} player${players.length === 1 ? '' : 's'}.\n` +
          `• \`.db\` — full restore (replace the volume's database file).\n` +
          `• \`.csv\` — readable points/links per Steam ID, for emergency manual rebuild.\n` +
          `Stash these somewhere off Railway.`,
        files,
      });
    } catch {
      return {
        content:
          "I couldn't DM you the backup — open your DMs (so I can message you) and run it again.",
      };
    }
    return { content: '📬 Sent the backup to your DMs.' };
  } catch (err) {
    console.error(`[backup] failed: ${err.message}`);
    return { content: `💀 Backup failed: ${err.message}` };
  } finally {
    fs.rm(tmpDb, { force: true }, () => {});
  }
}

// ── Prefix (!) commands ──────────────────────────────────────────────────────

// True if `userId` may run admin commands. When ADMIN_IDS is configured, only
// those IDs pass; otherwise fall back to Discord's Administrator permission.
function isAdmin(userId, member) {
  if (ADMIN_IDS.length) return ADMIN_IDS.includes(userId);
  return !!member?.permissions?.has(PermissionFlagsBits.Administrator);
}

async function handleCommand(message) {
  const [command, ...args] = message.content.trim().split(/\s+/);
  const cmd = command.toLowerCase();

  switch (cmd) {
    case '!help':
    case '!commands':
      await message.reply(payloadHelp(isAdmin(message.author.id, message.member)));
      return true;
    case '!points':
      await message.reply(await payloadPoints(message.author.id, message.author.username));
      return true;
    case '!stats':
    case '!card':
      await message.reply(await payloadStats(message.mentions.users.first() ?? message.author));
      return true;
    case '!rank':
      await message.reply(await payloadRank(message.author.id, message.author.username));
      return true;
    case '!leaderboard':
      await message.reply(await payloadLeaderboard());
      return true;
    case '!achievements':
      await message.reply(await payloadAchievements(message.mentions.users.first() ?? message.author));
      return true;
    case '!progress':
      await message.reply(await payloadProgress(message.mentions.users.first() ?? message.author));
      return true;
    case '!link': {
      // "!link @user" is a public lookup of who that person linked; "!link <id>"
      // links your own Steam.
      const mentioned = message.mentions.users.first();
      if (mentioned) {
        await message.reply(await payloadWhois(mentioned));
      } else {
        await message.reply(await actionLink(message.author.id, message.author.username, args[0]));
      }
      return true;
    }
    case '!unlink':
      await message.reply(actionUnlink(message.author.id, message.author.username));
      return true;
    case '!survey': {
      const p = await payloadSurvey();
      await message.channel.send(p.content);
      return true;
    }
    case '!backup': {
      if (!isAdmin(message.author.id, message.member)) {
        await message.reply('🔒 That command is admin-only.');
        return true;
      }
      await message.reply(await actionBackup(message.author));
      return true;
    }
    case '!addpoints':
    case '!setpoints': {
      if (!isAdmin(message.author.id, message.member)) {
        await message.reply('🔒 That command is admin-only.');
        return true;
      }
      const target = message.mentions.users.first();
      const amount = parseInt(args.find((a) => /^-?\d+$/.test(a)), 10);
      if (!target || Number.isNaN(amount)) {
        await message.reply(`Usage: \`${cmd} @user <number>\``);
        return true;
      }
      const member = message.mentions.members?.first();
      const targetName = member?.displayName ?? target.username;
      await message.reply(
        await actionAdjustPoints({
          targetId: target.id,
          targetName,
          mode: cmd === '!setpoints' ? 'set' : 'add',
          amount,
        })
      );
      return true;
    }
    default:
      // Friendly nudge for typo'd commands. (Commands only run in the
      // achievements channel and DMs now, so there's no free-chat channel to
      // stay quiet in here.)
      if (/^![a-z]+$/.test(cmd)) {
        await message.reply(`I don't know \`${cmd}\`. Try \`!help\` for everything I can do.`);
        return true;
      }
      return false;
  }
}

// ── Slash (/) commands ───────────────────────────────────────────────────────

function buildSlashCommands() {
  return [
    new SlashCommandBuilder().setName('help').setDescription('List every command'),
    new SlashCommandBuilder().setName('points').setDescription('Show your points'),
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Show a player\'s survivor card')
      .addUserOption((o) => o.setName('user').setDescription('Whose card (default: you)')),
    new SlashCommandBuilder().setName('rank').setDescription('Show your leaderboard rank'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Show the points leaderboard'),
    new SlashCommandBuilder()
      .setName('achievements')
      .setDescription("List a player's unlocked achievements")
      .addUserOption((o) => o.setName('user').setDescription('Whose achievements (default: you)')),
    new SlashCommandBuilder()
      .setName('progress')
      .setDescription('Show achievement completion %')
      .addUserOption((o) => o.setName('user').setDescription('Whose progress (default: you)')),
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Steam ID')
      .addStringOption((o) =>
        o.setName('steamid').setDescription('Your 17-digit SteamID64').setRequired(true)
      ),
    new SlashCommandBuilder().setName('unlink').setDescription('Unlink your Steam ID'),
    new SlashCommandBuilder().setName('survey').setDescription('Survivor asks the group a question'),
    new SlashCommandBuilder()
      .setName('addpoints')
      .setDescription('(Admin) Add points to a player')
      .addUserOption((o) => o.setName('user').setDescription('Player').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Points to add (can be negative)').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('setpoints')
      .setDescription("(Admin) Set a player's point total")
      .addUserOption((o) => o.setName('user').setDescription('Player').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('New point total').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('backup')
      .setDescription('(Admin) DM yourself a full database backup')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((c) => c.toJSON());
}

async function registerSlashCommands() {
  const data = buildSlashCommands();
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(data);
      console.log(`[slash] registered ${data.length} commands in "${guild.name}"`);
    } catch (err) {
      console.warn(
        `[slash] could not register commands in "${guild.name}": ${err.message}. ` +
          `Re-invite the bot with the "applications.commands" scope (see SETUP.md).`
      );
    }
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  try {
    switch (name) {
      case 'help':
        return interaction.reply({
          ...payloadHelp(isAdmin(interaction.user.id, interaction.member)),
          flags: MessageFlags.Ephemeral,
        });
      case 'points':
        return interaction.reply(await payloadPoints(interaction.user.id, interaction.user.username));
      case 'stats':
        await interaction.deferReply();
        return interaction.editReply(
          await payloadStats(interaction.options.getUser('user') ?? interaction.user)
        );
      case 'rank':
        return interaction.reply(await payloadRank(interaction.user.id, interaction.user.username));
      case 'leaderboard':
        await interaction.deferReply();
        return interaction.editReply(await payloadLeaderboard());
      case 'achievements':
        return interaction.reply(
          await payloadAchievements(interaction.options.getUser('user') ?? interaction.user)
        );
      case 'progress':
        await interaction.deferReply();
        return interaction.editReply(
          await payloadProgress(interaction.options.getUser('user') ?? interaction.user)
        );
      case 'link':
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(
          await actionLink(interaction.user.id, interaction.user.username, interaction.options.getString('steamid'))
        );
      case 'unlink':
        return interaction.reply({
          ...actionUnlink(interaction.user.id, interaction.user.username),
          flags: MessageFlags.Ephemeral,
        });
      case 'survey':
        await interaction.deferReply();
        return interaction.editReply(await payloadSurvey());
      case 'addpoints':
      case 'setpoints': {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          return interaction.reply({ content: '🔒 Admin-only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
        return interaction.editReply(
          await actionAdjustPoints({
            targetId: target.id,
            targetName: member?.displayName ?? target.username,
            mode: name === 'setpoints' ? 'set' : 'add',
            amount,
          })
        );
      }
      case 'backup': {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          return interaction.reply({ content: '🔒 Admin-only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(await actionBackup(interaction.user));
      }
      default:
        return;
    }
  } catch (err) {
    console.error(`[interaction] ${name} error: ${err.message}`);
    const content = '💀 Something broke out here in the woods. Try again.';
    if (interaction.deferred || interaction.replied) {
      interaction.editReply({ content }).catch(() => {});
    } else {
      interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ── Message routing ──────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content?.trim()) return;

  try {
    // Direct messages: Survivor chats privately, but ONLY about games and ONLY
    // with linked players (those who have run !link). Everyone else is ignored.
    if (message.channel.isDMBased()) {
      // Allow ! commands in DMs too, so players can !link (or !points, etc.)
      // without ever touching the server.
      if (message.content.startsWith('!')) {
        const handled = await handleCommand(message);
        if (handled) return;
      }
      if (onCooldown(message.author.id)) return; // spam guard
      const player = db.getPlayer(message.author.id);
      if (!player?.steam_id) {
        // Not a linked player — nudge them to link instead of staying silent.
        await message.reply(
          `I don't trade survival tips with ghosts. Link up first — run ` +
          `\`!link <your-steamid64>\` right here in this DM (or in the server), ` +
          `then come talk games with me.`
        );
        return;
      }
      await converse(message, { dm: true });
      return;
    }

    const inAchievementChannel =
      ACHIEVEMENT_CHANNEL_ID && message.channel.id === ACHIEVEMENT_CHANNEL_ID;
    const inChatChannel =
      SURVIVOR_CHAT_CHANNEL_ID && message.channel.id === SURVIVOR_CHAT_CHANNEL_ID;

    // The achievements channel is commands-only: ! commands run here, and any
    // other (non-command) message gets deleted on sight to keep it clean.
    if (inAchievementChannel) {
      if (message.content.startsWith('!')) {
        await handleCommand(message);
      } else {
        await deleteAndNotify(
          message,
          `🌲 <@${message.author.id}> the achievements channel is commands-only — ` +
            `talk to me in the chat channel. Try \`!help\` to see what I do here.`
        );
      }
      return;
    }

    // The chat channel: Survivor converses, but each user gets a rolling budget
    // of messages so nobody can flood it. Over budget → delete + a quick heads-up.
    if (inChatChannel) {
      const budget = spendChatBudget(message.author.id);
      if (!budget.allowed) {
        await deleteAndNotify(
          message,
          `🪵 <@${message.author.id}> you've used your ${CHAT_BUDGET} messages this hour — ` +
            `give the forest a rest (try again in ~${budget.retryMinutes} min).`
        );
        return;
      }
      if (onCooldown(message.author.id)) return; // finer per-message throttle
      await converse(message);
      return;
    }

    // No designated achievements channel configured yet → don't lock commands to
    // nowhere; let them work anywhere so the bot is usable before setup.
    if (!ACHIEVEMENT_CHANNEL_ID && message.content.startsWith('!')) {
      await handleCommand(message);
    }
  } catch (err) {
    console.error(`[message] handler error: ${err.message}`);
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`✅ Survivor is awake as ${client.user.tag}`);

  // Health alerts → log channel (or the achievement channel as a fallback).
  health.setNotifier(async (text) => {
    const ch = (await fetchChannel(LOG_CHANNEL_ID)) ?? (await getAchievementChannel());
    if (ch) ch.send(text).catch(() => {});
  });

  if (SURVIVOR_CHAT_CHANNEL_ID) {
    console.log(`💬 Survivor will chat ONLY in channel ${SURVIVOR_CHAT_CHANNEL_ID}`);
  } else {
    console.log('💬 No SURVIVOR_CHAT_CHANNEL_ID set — Survivor will not chat anywhere.');
  }
  console.log(
    `⚙️  now-playing: ${nowPlayingOn ? 'on' : 'off'} | weekly recap: ${recapOn ? 'on' : 'off'} | ` +
      `backfill: ${backfillOn ? 'on' : 'off'}`
  );

  seedFromEnv();
  loadChatHistory();
  await registerSlashCommands();
  startRecapScheduler();

  await pollAllPlayers();
  const interval = Number(POLL_INTERVAL_MS) || 300000;
  setInterval(pollAllPlayers, interval);
  console.log(`⏱️  Polling Steam every ${Math.round(interval / 1000)}s`);
});

client.login(DISCORD_BOT_TOKEN);

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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import * as db from './src/db.js';
import {
  getPlayerAchievements,
  getPlayerSummary,
  getGlobalAchievementPct,
  probeAchievementAccess,
  getRecentlyPlayedGames,
} from './src/steam.js';
import * as survivor from './src/survivor.js';
import * as health from './src/health.js';
import {
  LINK_ROLE,
  REWARDS,
  milestonesCrossed,
  rewardForPoints,
  rarityTier,
  voiceMilestonesCrossed,
} from './src/rewards.js';
import { TRACKED_APP_IDS, gameName, rememberGameName } from './src/games.js';

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
  PRIZE_POINTS_THRESHOLD = '500',
  GAME_VOICE_CHANNEL_ID = '',
  VOICE_KICK_UNLINKED = 'false',
  VOICE_LINK_GRACE_SECONDS = '120',
  VOICE_POINTS_PER_INTERVAL = '3',
  VOICE_POINTS_INTERVAL_MIN = '10',
  VOICE_DRIP_ANNOUNCE = 'true',
  ACH_COMMAND_CLEANUP_SEC = '60',
  TRACK_ALL_GAMES = 'false',
} = process.env;

// Who may run admin commands (!backup, !addpoints, !setpoints). If ADMIN_DISCORD_IDS
// (or OWNER_DISCORD_ID) is set, ONLY those exact Discord user IDs qualify — server
// "Administrator" permission no longer counts. If neither is set, we fall back to
// the Administrator permission so the bot isn't accidentally locked before setup.
const ADMIN_IDS = (ADMIN_DISCORD_IDS || OWNER_DISCORD_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Points a player must reach before they can claim an admin-set prize.
const PRIZE_THRESHOLD = Number(PRIZE_POINTS_THRESHOLD) || 500;

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

// Voice-channel tracking. Only active when GAME_VOICE_CHANNEL_ID is set.
const kickUnlinked = VOICE_KICK_UNLINKED === 'true';
const VOICE_GRACE_SEC = Number(VOICE_LINK_GRACE_SECONDS) || 120;
const VOICE_FLUSH_MS = 60 * 1000; // credit active voice sessions once a minute
// Steady "drip" reward: every VOICE_DRIP_INTERVAL_SEC of cumulative voice time a
// linked player earns VOICE_DRIP_POINTS points, silently (no announcement — the
// big VOICE_MILESTONES hour thresholds still announce). Set VOICE_POINTS_PER_INTERVAL
// to 0 to disable the drip and keep only the milestones.
const VOICE_DRIP_POINTS = Math.max(0, Number(VOICE_POINTS_PER_INTERVAL) || 0);
const VOICE_DRIP_INTERVAL_SEC = (Number(VOICE_POINTS_INTERVAL_MIN) || 10) * 60;
// When true, each drip posts ONE message per voice session and edits it in place
// as the session total climbs (no per-interval spam). Set false to stay silent.
const voiceDripAnnounce = VOICE_DRIP_ANNOUNCE === 'true';
// In the achievement channel, auto-delete a player's read-only command + Survivor's
// reply after this many seconds to keep the feed clean. 0 disables the cleanup.
const achCleanupMs = Math.max(0, Number(ACH_COMMAND_CLEANUP_SEC) || 0) * 1000;
// Count achievements from games OTHER than The Forest / Sons of the Forest.
const trackAllGames = TRACK_ALL_GAMES === 'true';

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
    GatewayIntentBits.GuildVoiceStates,
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

/** Take a role away across every guild (used when a player unlinks). Silently
 *  skips guilds where the role or member is missing. */
async function removeRole(discordId, roleName) {
  for (const guild of client.guilds.cache.values()) {
    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (!role) continue;
    let member;
    try {
      member = await guild.members.fetch(discordId);
    } catch {
      continue;
    }
    if (!member.roles.cache.has(role.id)) continue;
    try {
      await member.roles.remove(role);
      console.log(`[roles] removed "${roleName}" from ${discordId}`);
    } catch (err) {
      console.warn(
        `[roles] failed to remove "${roleName}" from ${discordId}: ${err.message}. ` +
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
    await processGameAchievements(player, appId, name, gameName(appId), channel, {
      baselineOnly: false,
    });
  }

  // Optionally also count achievements from any OTHER game the player has been
  // playing recently. The first time we see a given game for a player we baseline
  // it silently (no retroactive points), then award only new unlocks afterward.
  if (trackAllGames) {
    const recent = await getRecentlyPlayedGames(player.steam_id);
    for (const g of recent ?? []) {
      if (TRACKED_APP_IDS.includes(g.appId)) continue;
      rememberGameName(g.appId, g.name);
      const seen = db.gameSeenForPlayer(player.discord_id, g.appId);
      await processGameAchievements(player, g.appId, name, g.name, channel, {
        baselineOnly: !seen,
      });
    }
  }
}

/**
 * Award (or, on a game's first sighting, silently baseline) a player's unlocked
 * achievements for one game. Shared by the Forest games and — when
 * TRACK_ALL_GAMES is on — any other recently-played game.
 */
async function processGameAchievements(player, appId, playerName, gameLabel, channel, { baselineOnly }) {
  const achievements = await getPlayerAchievements(player.steam_id, appId);
  if (!achievements) return;

  // First time we've seen this game for the player: record what they already
  // have as a baseline (no points, no announcements) so only future unlocks earn.
  if (baselineOnly) {
    let existing = 0;
    for (const ach of achievements) {
      if (!ach.achieved) continue;
      db.recordAchievement(player.discord_id, appId, ach.apiname, ach.displayName, ach.unlockTime, 0);
      existing += 1;
    }
    console.log(`[poll] baselined ${gameLabel} for ${player.discord_id} (${existing} achievements, no points)`);
    return;
  }

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
    await announceAchievement(channel, playerName, ach.displayName, gameLabel, after, {
      gained,
      firstBloodBonus,
      rarity,
      rarityPct: pct,
      rarityBonus,
      streak,
      streakBonus: Math.max(0, streakBonus),
    });
    await handleMilestones(channel, player.discord_id, playerName, before, after);
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

// ── Voice activity ───────────────────────────────────────────────────────────
// Track time linked players spend together in the game voice channel. Time is
// credited to a cumulative total; crossing a VOICE_MILESTONES hour threshold
// awards points and announces a newbie→veteran rank in the achievement channel.
// Unlinked players who join can be warned + kicked after a grace period.

const voiceSessions = new Map(); // discordId -> { since: ms } (active in the channel)
const unlinkedKickTimers = new Map(); // discordId -> Timeout
const voiceDripMsgs = new Map(); // discordId -> { message, points } (live drip message for the current session)

// Post-or-edit a single "live" drip message per voice session, so the running
// point total updates in place instead of spamming a new message each interval.
async function announceVoiceDrip(player, gained) {
  const channel = await getAchievementChannel();
  if (!channel) return;
  const entry = voiceDripMsgs.get(player.discord_id) ?? { message: null, points: 0 };
  entry.points += gained;
  const content =
    `🎙️ <@${player.discord_id}> is racking up voice points — **+${entry.points} pts** this session and counting.`;
  try {
    if (entry.message) {
      await entry.message.edit({ content, allowedMentions: { parse: [] } });
    } else {
      // Ping once on the first post; later edits never re-ping.
      entry.message = await channel.send({ content, allowedMentions: { users: [player.discord_id] } });
    }
  } catch {
    entry.message = null; // edit target vanished — re-post next interval
  }
  voiceDripMsgs.set(player.discord_id, entry);
}

// On leave, edit the live message one last time into a session summary.
async function finalizeVoiceDrip(userId) {
  const entry = voiceDripMsgs.get(userId);
  voiceDripMsgs.delete(userId);
  if (!entry?.message) return;
  const total = db.getPlayer(userId)?.points ?? 0;
  await entry.message
    .edit({
      content:
        `🎙️ <@${userId}> left voice — earned **+${entry.points} pts** this session. Total: **${total} pts**.`,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

async function handleVoiceMilestones(player, beforeSec, afterSec) {
  const crossed = voiceMilestonesCrossed(beforeSec / 3600, afterSec / 3600);
  if (crossed.length === 0) return;
  const channel = await getAchievementChannel();
  const name = await displayName(player);
  for (const m of crossed) {
    const before = db.getPlayer(player.discord_id).points;
    const after = db.addPoints(player.discord_id, m.points);
    const line = await survivor.commentVoiceMilestone(name, m.hours, m.label);
    const embed = new EmbedBuilder()
      .setColor(0x9c27b0)
      .setDescription(
        `${m.emoji} **${name}** reached **${m.hours}h** in voice — **${m.label}**!\n\n` +
          `${line}\n\n**+${m.points} pts** | Total: **${after} pts**`
      );
    if (channel) await channel.send({ embeds: [embed] });
    // Voice points can also trip the normal 100/200/300/500 role milestones.
    await handleMilestones(channel, player.discord_id, name, before, after);
    await assignRolesUpTo(player.discord_id, after);
  }
}

// Steady points for time in voice: award VOICE_DRIP_POINTS for every whole
// VOICE_DRIP_INTERVAL_SEC of cumulative voice time newly crossed. Optionally shows
// a single live-updating message per session (VOICE_DRIP_ANNOUNCE), and still trips
// role rewards if points cross a 100/200/300/500 threshold.
async function handleVoiceDrip(player, beforeSec, afterSec) {
  if (VOICE_DRIP_POINTS <= 0) return;
  const intervalsCrossed =
    Math.floor(afterSec / VOICE_DRIP_INTERVAL_SEC) - Math.floor(beforeSec / VOICE_DRIP_INTERVAL_SEC);
  if (intervalsCrossed <= 0) return;
  const gained = intervalsCrossed * VOICE_DRIP_POINTS;
  const before = db.getPlayer(player.discord_id).points;
  const after = db.addPoints(player.discord_id, gained);
  if (voiceDripAnnounce) await announceVoiceDrip(player, gained);
  const channel = await getAchievementChannel();
  const name = await displayName(player);
  await handleMilestones(channel, player.discord_id, name, before, after);
  await assignRolesUpTo(player.discord_id, after);
}

/** Credit elapsed time for one active voice session. Only linked players earn. */
async function creditVoiceSession(userId, { remove }) {
  const sess = voiceSessions.get(userId);
  if (!sess) return;
  const elapsedSec = (Date.now() - sess.since) / 1000;
  sess.since = Date.now();
  if (remove) voiceSessions.delete(userId);

  const player = db.getPlayer(userId);
  if (!player?.steam_id || elapsedSec < 1) return; // unlinked time isn't counted
  const before = db.getVoiceSeconds(userId);
  const after = db.addVoiceSeconds(userId, elapsedSec);
  await handleVoiceDrip(player, before, after);
  await handleVoiceMilestones(player, before, after);
}

/** Periodic sweep so long, ongoing sessions still announce milestones in time. */
async function flushVoiceSessions() {
  for (const userId of [...voiceSessions.keys()]) {
    try {
      await creditVoiceSession(userId, { remove: false });
    } catch (err) {
      console.error(`[voice] flush error for ${userId}: ${err.message}`);
    }
  }
}

/** DM an unlinked joiner, then disconnect them after the grace period unless they
 *  link (or leave) in time. Needs the "Move Members" permission to disconnect. */
function scheduleUnlinkedKick(member) {
  if (unlinkedKickTimers.has(member.id)) return;
  member.user
    .send(
      `🌲 You hopped into the game voice channel but haven't linked your Steam yet. ` +
        `Run \`!link <steamid64>\` (here in my DMs or in the server) within ` +
        `**${VOICE_GRACE_SEC} seconds**, or I'll boot you from the channel. ` +
        `Find your SteamID64 at https://steamid.io/`
    )
    .catch(() => {});

  const timer = setTimeout(async () => {
    unlinkedKickTimers.delete(member.id);
    try {
      if (db.getPlayer(member.id)?.steam_id) return; // linked in time — let them be
      const m = await member.guild.members.fetch(member.id).catch(() => null);
      if (!m || m.voice?.channelId !== GAME_VOICE_CHANNEL_ID) return; // already left
      await m.voice.disconnect('Not linked to Steam').catch((err) => {
        console.warn(
          `[voice] couldn't disconnect ${member.id}: ${err.message}. ` +
            `Give the bot the "Move Members" permission.`
        );
      });
      m.user
        .send(`🚪 Booted you from the game voice — link your Steam with \`!link <steamid64>\` and hop back in.`)
        .catch(() => {});
    } catch (err) {
      console.error(`[voice] kick error for ${member.id}: ${err.message}`);
    }
  }, VOICE_GRACE_SEC * 1000);
  unlinkedKickTimers.set(member.id, timer);
}

function onJoinGameVoice(member) {
  voiceSessions.set(member.id, { since: Date.now() });
  if (kickUnlinked && !db.getPlayer(member.id)?.steam_id) scheduleUnlinkedKick(member);
}

async function onLeaveGameVoice(member) {
  const timer = unlinkedKickTimers.get(member.id);
  if (timer) {
    clearTimeout(timer);
    unlinkedKickTimers.delete(member.id);
  }
  await creditVoiceSession(member.id, { remove: true });
  await finalizeVoiceDrip(member.id);
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (!GAME_VOICE_CHANNEL_ID) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    const was = oldState.channelId === GAME_VOICE_CHANNEL_ID;
    const is = newState.channelId === GAME_VOICE_CHANNEL_ID;
    if (was === is) return; // mute/deafen toggle or unrelated channel — ignore
    if (is) onJoinGameVoice(member);
    else await onLeaveGameVoice(member);
  } catch (err) {
    console.error(`[voice] state update error: ${err.message}`);
  }
});

// A player can `!link` from a DM before ever joining the server, so there's no
// member to give the Castaway role to at link time. Catch them here: when a
// linked user joins the guild, grant it.
client.on('guildMemberAdd', async (member) => {
  try {
    if (member.user.bot) return;
    if (!db.getPlayer(member.id)?.steam_id) return;
    await assignRole(member.id, LINK_ROLE.role);
  } catch (err) {
    console.warn(`[roles] guildMemberAdd error for ${member.id}: ${err.message}`);
  }
});

/** On boot, give the Castaway role to every linked player who's missing it
 *  (e.g. players who linked before this feature existed). Safe to re-run. */
async function backfillLinkRole() {
  for (const player of db.getLinkedPlayers()) {
    await assignRole(player.discord_id, LINK_ROLE.role).catch(() => {});
  }
}

/** On boot, pick up anyone already sitting in the voice channel. */
async function initVoiceTracking() {
  if (!GAME_VOICE_CHANNEL_ID) return;
  const channel = await fetchChannel(GAME_VOICE_CHANNEL_ID);
  for (const member of channel?.members?.values?.() ?? []) {
    if (!member.user.bot) onJoinGameVoice(member);
  }
  setInterval(() => flushVoiceSessions().catch(() => {}), VOICE_FLUSH_MS);
  const drip =
    VOICE_DRIP_POINTS > 0
      ? `+${VOICE_DRIP_POINTS} pts / ${VOICE_DRIP_INTERVAL_SEC / 60} min`
      : 'milestones only';
  console.log(
    `🎙️  Voice tracking on for channel ${GAME_VOICE_CHANNEL_ID} ` +
      `(kick unlinked: ${kickUnlinked ? `yes, after ${VOICE_GRACE_SEC}s` : 'no'}; drip: ${drip}).`
  );
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
// CHAT_BUDGET messages per CHAT_BUDGET_WINDOW_MS. The per-message timestamps are
// in-memory (a restart forgives everyone), but the *limit* itself is persisted in
// the DB so `!chatlimit` survives restarts/redeploys. Default 5.
let CHAT_BUDGET = Number(db.getMeta('chat_limit')) || 5;
const CHAT_BUDGET_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const chatBudget = new Map(); // userId -> [timestamps within the window]
const budgetNotified = new Set(); // userIds already told they're over budget (reset on replenish)

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
  budgetNotified.delete(userId); // they have room again — allow a fresh notice next time
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

  // In a server channel, tag the user Survivor is answering so it's clear who the
  // reply is for. (Skip the tag in DMs — it's just the two of you there.) The
  // owner is only pinged when OWNER_PING=true and they're actually named.
  const mentionUsers = dm ? [] : [message.author.id];
  if (OWNER_PING === 'true' && OWNER_DISCORD_ID) mentionUsers.push(OWNER_DISCORD_ID);
  const allowedMentions = { users: mentionUsers, repliedUser: true };
  const content = dm ? reply : `<@${message.author.id}> ${reply}`;
  await message.reply({ content, allowedMentions });
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
    '`!feedback` — send the admins a bug report or suggestion',
    `\`!prize\` — view & claim the prize an admin set for you (needs ${PRIZE_THRESHOLD} pts)`,
    '`!unlink` — remove your Steam link (your points stay)',
    '`!help` — this list',
    '',
    '**💰 How points work**',
    `> +${POINTS_PER_ACHIEVEMENT} per achievement · 🩸 +${FIRST_BLOOD_BONUS} for being first in the group to grab one · ` +
      `💎 rarity bonus for hard ones · 🔥 streak bonus for unlocking on back-to-back days` +
      (GAME_VOICE_CHANNEL_ID ? ' · 🎙️ bonus points for hours spent in the game voice channel.' : '.'),
  ];
  if (isAdminUser) {
    lines.push(
      '',
      '**🔒 Admin only**',
      '`!addpoints @user <n>` — add points (negative to subtract)',
      '`!setpoints @user <n>` — set a point total',
      '`!chatlimit [<n>]` — show or set the chat channel\'s messages-per-hour limit',
      '`!prizefor [@user]` — set a prize image (lists linked players if no @user)',
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

/** Format a voice-seconds total as a compact "Xh Ym" (or "Ym" under an hour). */
function formatVoiceTime(seconds) {
  const total = Math.floor((seconds || 0) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

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
    ...(GAME_VOICE_CHANNEL_ID || player.voice_seconds
      ? [{ name: '🎙️ Voice', value: formatVoiceTime(player.voice_seconds), inline: true }]
      : []),
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
  // Welcome them into the tribe. If they linked from a DM and aren't in the
  // server yet, assignRole just no-ops — guildMemberAdd grants it when they join.
  assignRole(userId, LINK_ROLE.role).catch(() => {});
  const summary = await getPlayerSummary(steamId);
  if (summary?.personaname) db.setSteamName(userId, summary.personaname);
  const named = summary?.personaname ? ` account **${summary.personaname}**` : '';
  return {
    content:
      `🔗 Linked **${username}** to Steam${named}. ` +
      `You're a ${LINK_ROLE.emoji} **${LINK_ROLE.name}** now — welcome to the tribe. ` +
      `Go unlock something — I'm watching. Try \`!stats\` to see your card or \`!help\` for everything.`,
  };
}

function actionUnlink(userId, username) {
  const player = db.getPlayer(userId);
  if (!player?.steam_id) {
    return { content: `**${username}**, you don't have a Steam account linked.` };
  }
  db.unlinkPlayer(userId);
  // Strip the tribe role so channel access follows link status exactly. Their
  // point-milestone roles stay — only the Castaway entry role is removed.
  removeRole(userId, LINK_ROLE.role).catch(() => {});
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
    const header =
      'discord_id,steam_id,steam_name,points,current_streak,best_streak,last_milestone,voice_seconds';
    const rows = players.map((p) =>
      [
        p.discord_id,
        p.steam_id,
        p.steam_name,
        p.points,
        p.current_streak,
        p.best_streak,
        p.last_milestone,
        p.voice_seconds,
      ]
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

// ── Prizes ─────────────────────────────────────────────────────────────────
// Admins set a per-player prize (an image + optional notes) with `!prizefor`.
// A player views theirs with `!prize` and claims it via a button once they hit
// PRIZE_THRESHOLD points — claiming DMs the admin to hand the prize over.

// Short-lived per-(channel, admin) state for the multi-step `!prizefor` flow:
// pick a player (by number), then upload the image.
const prizeFlows = new Map(); // "channelId:userId" -> { step, ... , expires }
const PRIZE_FLOW_TTL_MS = 5 * 60 * 1000;

const prizeFlowKey = (message) => `${message.channel.id}:${message.author.id}`;

function isImageAttachment(att) {
  return (
    (att.contentType || '').startsWith('image/') ||
    /\.(png|jpe?g|gif|webp)$/i.test(att.name || '')
  );
}

/** Kick off `!prizefor`: either jump straight to a mentioned user, or list the
 *  linked players so the admin can pick one by number. */
async function beginPrizeFor(message) {
  const key = prizeFlowKey(message);
  const mentioned = message.mentions.users.first();
  if (mentioned) {
    const name = message.mentions.members?.first()?.displayName ?? mentioned.username;
    prizeFlows.set(key, {
      step: 'upload',
      targetId: mentioned.id,
      targetName: name,
      expires: Date.now() + PRIZE_FLOW_TTL_MS,
    });
    await message.reply(
      `📸 Setting a prize for **${name}**. Send an **image attachment** here ` +
        `(type any notes as the message text), or say \`cancel\`.\n` +
        `_Tip: do this in my DMs if you want to keep it a surprise._`
    );
    return;
  }

  const players = db.getLinkedPlayers();
  if (players.length === 0) {
    await message.reply("Nobody's linked a Steam account yet — there's no one to set a prize for.");
    return;
  }
  const users = await Promise.all(
    players.map(async (p) => ({ discord_id: p.discord_id, name: await displayName(p) }))
  );
  prizeFlows.set(key, { step: 'pick', users, expires: Date.now() + PRIZE_FLOW_TTL_MS });
  const list = users.map((u, i) => `**${i + 1}.** ${u.name}`).join('\n');
  await message.reply(
    `🎁 **Set a prize for who?** Reply with a number (or \`cancel\`):\n\n${list}`
  );
}

/** Continue an in-progress `!prizefor` flow. Returns true if the message was
 *  consumed by the flow (so the caller should stop processing it). */
async function continuePrizeFlow(message) {
  const key = prizeFlowKey(message);
  const flow = prizeFlows.get(key);
  if (!flow) return false;

  // Let the admin restart cleanly by re-running the command.
  if (/^!prizefor\b/i.test(message.content.trim())) {
    prizeFlows.delete(key);
    return false;
  }
  if (Date.now() > flow.expires) {
    prizeFlows.delete(key);
    return false;
  }

  const text = message.content.trim();
  if (/^!?cancel$/i.test(text)) {
    prizeFlows.delete(key);
    await message.reply('❌ Prize setup cancelled.');
    return true;
  }

  if (flow.step === 'pick') {
    const n = Number.parseInt(text, 10);
    if (!Number.isInteger(n) || n < 1 || n > flow.users.length) {
      await message.reply(`Reply with a number from **1** to **${flow.users.length}**, or \`cancel\`.`);
      return true;
    }
    const target = flow.users[n - 1];
    flow.step = 'upload';
    flow.targetId = target.discord_id;
    flow.targetName = target.name;
    flow.expires = Date.now() + PRIZE_FLOW_TTL_MS;
    await message.reply(
      `📸 Setting a prize for **${target.name}**. Send an **image attachment** here ` +
        `(type any notes as the message text), or say \`cancel\`.`
    );
    return true;
  }

  if (flow.step === 'upload') {
    const att = message.attachments.find(isImageAttachment);
    if (!att) {
      await message.reply('I need an **image attachment** for the prize. Attach a picture (with optional notes), or say `cancel`.');
      return true;
    }
    let buffer;
    try {
      buffer = Buffer.from(await (await fetch(att.url)).arrayBuffer());
    } catch (err) {
      console.error(`[prize] image download failed: ${err.message}`);
      await message.reply('Couldn\'t download that image — try sending it again.');
      return true;
    }
    const notes = message.content.trim() || null;
    db.setPrize(flow.targetId, {
      image: buffer,
      imageName: att.name || 'prize.png',
      notes,
      setBy: message.author.id,
    });
    prizeFlows.delete(key);
    await message.reply(
      `🎁 Prize set for **${flow.targetName}**! They can run \`!prize\` to view it and ` +
        `claim it once they reach **${PRIZE_THRESHOLD}** points.`
    );
    return true;
  }

  return false;
}

/** One-shot prize set (used by the `/prizefor` slash command). */
async function actionPrizeFor({ targetId, targetName, attachment, notes, setBy }) {
  if (!attachment || !isImageAttachment(attachment)) {
    return { content: 'The prize needs to be an **image** (png/jpg/gif/webp).' };
  }
  let buffer;
  try {
    buffer = Buffer.from(await (await fetch(attachment.url)).arrayBuffer());
  } catch (err) {
    console.error(`[prize] image download failed: ${err.message}`);
    return { content: 'Couldn\'t download that image — try again.' };
  }
  db.setPrize(targetId, {
    image: buffer,
    imageName: attachment.name || 'prize.png',
    notes: notes || null,
    setBy,
  });
  return {
    content:
      `🎁 Prize set for **${targetName}**! They can run \`/prize\` to view it and ` +
      `claim it once they reach **${PRIZE_THRESHOLD}** points.`,
  };
}

/** The prize card a player sees from `!prize` / `/prize`. */
function payloadPrize(user) {
  const prize = db.getPrize(user.id);
  if (!prize) {
    return {
      content:
        `🎁 No prize is waiting for you yet, **${user.username}**. ` +
        `Keep unlocking achievements — the admins hand these out.`,
    };
  }

  const points = db.getPlayer(user.id)?.points ?? 0;
  const eligible = points >= PRIZE_THRESHOLD;
  const remaining = Math.max(0, PRIZE_THRESHOLD - points);

  const file = new AttachmentBuilder(prize.image, { name: 'prize.png' });
  const embed = new EmbedBuilder()
    .setColor(prize.claimed ? 0x9e9e9e : eligible ? 0xffd700 : 0x607d8b)
    .setTitle(`🎁 ${user.username}'s Prize`)
    .setImage('attachment://prize.png')
    .addFields(
      { name: '🪵 Your points', value: `**${points}** / ${PRIZE_THRESHOLD}`, inline: true },
      {
        name: prize.claimed ? '📦 Status' : eligible ? '✅ Status' : '🔒 Status',
        value: prize.claimed
          ? 'Already claimed 🎉'
          : eligible
            ? 'Ready to claim!'
            : `**${remaining}** pts to go`,
        inline: true,
      }
    );
  if (prize.notes) embed.setDescription(prize.notes);
  embed.setFooter({
    text: prize.claimed
      ? 'The admin has been notified to hand it over.'
      : eligible
        ? 'Hit the button to claim it!'
        : `Reach ${PRIZE_THRESHOLD} points to unlock the claim button.`,
  });

  const button = new ButtonBuilder()
    .setCustomId(`prize_claim:${user.id}`)
    .setLabel(prize.claimed ? 'Claimed' : 'Take Prize')
    .setEmoji('🎁')
    .setStyle(prize.claimed ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(prize.claimed === 1);
  const row = new ActionRowBuilder().addComponents(button);

  return { embeds: [embed], components: [row], files: [file] };
}

/** DM the admin(s) that a prize was claimed; fall back to the channel if no DM
 *  lands. */
async function notifyPrizeClaim(prize, recipientId, username, points) {
  const msg =
    `🎁 **Prize claimed!** <@${recipientId}> (**${username}**) just claimed their prize ` +
    `with **${points}** points — time to hand it over!`;

  const targets = [];
  if (prize.set_by) targets.push(prize.set_by);
  if (OWNER_DISCORD_ID && !targets.includes(OWNER_DISCORD_ID)) targets.push(OWNER_DISCORD_ID);

  let delivered = false;
  for (const adminId of targets) {
    try {
      const u = await client.users.fetch(adminId);
      await u.send(msg);
      delivered = true;
    } catch (err) {
      console.warn(`[prize] couldn't DM admin ${adminId}: ${err.message}`);
    }
  }
  if (!delivered) {
    const ch = await getAchievementChannel();
    if (ch) ch.send(msg).catch(() => {});
  }
}

/** Handle a click on a prize's "Take Prize" button. */
async function handlePrizeButton(interaction) {
  const [action, recipientId] = interaction.customId.split(':');
  if (action !== 'prize_claim') return;

  if (interaction.user.id !== recipientId) {
    return interaction.reply({
      content: "🚫 That's not your prize to claim.",
      flags: MessageFlags.Ephemeral,
    });
  }
  const prize = db.getPrize(recipientId);
  if (!prize) {
    return interaction.reply({
      content: 'That prize is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (prize.claimed) {
    return interaction.reply({
      content: '🎉 You already claimed this prize — the admin has been notified.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const points = db.getPlayer(recipientId)?.points ?? 0;
  if (points < PRIZE_THRESHOLD) {
    return interaction.reply({
      content:
        `🔒 You need **${PRIZE_THRESHOLD - points}** more point${PRIZE_THRESHOLD - points === 1 ? '' : 's'} ` +
        `to claim this (you have **${points}** / ${PRIZE_THRESHOLD}). Go unlock something!`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Atomic claim: markPrizeClaimed only flips an as-yet-unclaimed row, so a
  // double-click can't notify the admin twice.
  if (!db.markPrizeClaimed(recipientId)) {
    return interaction.reply({
      content: '🎉 Already claimed — the admin has been notified.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await notifyPrizeClaim(prize, recipientId, interaction.user.username, points);

  await interaction.reply({
    content: '🎉 **Prize claimed!** The admin has been pinged to hand it over.',
    flags: MessageFlags.Ephemeral,
  });

  // Grey out the button on the original card so it reads as claimed.
  try {
    const claimedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(interaction.customId)
        .setLabel('Claimed')
        .setEmoji('🎁')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
    await interaction.message.edit({ components: [claimedRow] });
  } catch {
    /* best-effort */
  }
}

// ── Feedback & suggestions ───────────────────────────────────────────────────
// Players open a modal (a popup form with a real Submit button, so Enter just
// adds a newline) and their note is DM'd to the admins + posted to the log
// channel. Modals can only be opened from an interaction, so `!feedback` posts a
// button to click, while `/feedback` opens the modal straight away.

/** The little "Give Feedback" button used by the `!feedback` prefix command. */
function feedbackButtonPayload() {
  const button = new ButtonBuilder()
    .setCustomId('feedback_open')
    .setLabel('Give Feedback')
    .setEmoji('📝')
    .setStyle(ButtonStyle.Primary);
  return {
    content: '📝 Got a bug, an idea, or a suggestion? Hit the button and tell the admins.',
    components: [new ActionRowBuilder().addComponents(button)],
  };
}

/** Pop the feedback form. Must be the first response to the interaction (you
 *  can't showModal after replying/deferring). */
async function showFeedbackModal(interaction) {
  const input = new TextInputBuilder()
    .setCustomId('feedback_text')
    .setLabel('Your feedback or suggestion')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('A bug you hit, a feature you want, a command idea…')
    .setRequired(true)
    .setMaxLength(1000);
  const modal = new ModalBuilder()
    .setCustomId('feedback_submit')
    .setTitle('Feedback & Suggestions')
    .addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

/** Deliver a submitted note by DMing each admin (ADMIN_DISCORD_IDS, or the owner
 *  if none are set). Only falls back to a channel post if we couldn't DM anyone,
 *  so feedback is never silently lost but normally never clutters a channel. */
async function deliverFeedback(user, text) {
  const msg =
    `📝 **Feedback from <@${user.id}> (${user.username})**:\n>>> ${text}`;

  const targets = ADMIN_IDS.length ? ADMIN_IDS : OWNER_DISCORD_ID ? [OWNER_DISCORD_ID] : [];
  let dmed = false;
  for (const adminId of targets) {
    try {
      const u = await client.users.fetch(adminId);
      await u.send(msg);
      dmed = true;
    } catch (err) {
      console.warn(`[feedback] couldn't DM admin ${adminId}: ${err.message}`);
    }
  }

  // Last-resort fallback only: if no admin DM got through (e.g. DMs closed or no
  // admins configured), post to the log/achievement channel so it isn't lost.
  if (!dmed) {
    const ch = (await fetchChannel(LOG_CHANNEL_ID)) ?? (await getAchievementChannel());
    if (ch) ch.send(msg).catch(() => {});
  }
}

/** Handle a submitted feedback modal. */
async function handleFeedbackSubmit(interaction) {
  const text = interaction.fields.getTextInputValue('feedback_text').trim();
  if (!text) {
    return interaction.reply({ content: 'Nothing to send — the form was empty.', flags: MessageFlags.Ephemeral });
  }
  await deliverFeedback(interaction.user, text);
  // Remove the "Give Feedback" button prompt now that it's been used (no-op for
  // the /feedback modal, which has no source message).
  await interaction.message?.delete().catch(() => {});
  return interaction.reply({
    content: '🙏 Thanks — your feedback landed with the admins. The tribe grows stronger.',
    flags: MessageFlags.Ephemeral,
  });
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
    case '!prize':
      await message.reply(payloadPrize(message.author));
      return true;
    case '!prizefor': {
      if (!isAdmin(message.author.id, message.member)) {
        await message.reply('🔒 That command is admin-only.');
        return true;
      }
      await beginPrizeFor(message);
      return true;
    }
    case '!survey': {
      const p = await payloadSurvey();
      await message.channel.send(p.content);
      return true;
    }
    case '!feedback':
    case '!suggest':
      await message.reply(feedbackButtonPayload());
      return true;
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
    case '!chatlimit': {
      if (!isAdmin(message.author.id, message.member)) {
        await message.reply('🔒 That command is admin-only.');
        return true;
      }
      const raw = args.find((a) => /^\d+$/.test(a));
      if (raw === undefined) {
        await message.reply(
          `🪵 Chat limit is currently **${CHAT_BUDGET}** messages per hour per player. ` +
            `Set it with \`!chatlimit <number>\`.`
        );
        return true;
      }
      const n = parseInt(raw, 10);
      if (n < 1 || n > 100) {
        await message.reply('Pick a number between **1** and **100**.');
        return true;
      }
      CHAT_BUDGET = n;
      db.setMeta('chat_limit', n);
      await message.reply(`✅ Chat limit set to **${n}** messages per hour per player.`);
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
      .setName('feedback')
      .setDescription('Send feedback or a suggestion to the admins'),
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
    new SlashCommandBuilder()
      .setName('prize')
      .setDescription('View (and claim) the prize an admin set for you'),
    new SlashCommandBuilder()
      .setName('prizefor')
      .setDescription('(Admin) Set a prize image for a player')
      .addUserOption((o) => o.setName('user').setDescription('Who the prize is for').setRequired(true))
      .addAttachmentOption((o) =>
        o.setName('image').setDescription('The prize picture').setRequired(true)
      )
      .addStringOption((o) => o.setName('notes').setDescription('Optional notes shown under the image'))
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
  if (interaction.isButton()) {
    try {
      if (interaction.customId === 'feedback_open') {
        await showFeedbackModal(interaction);
      } else {
        await handlePrizeButton(interaction);
      }
    } catch (err) {
      console.error(`[interaction] button error: ${err.message}`);
      if (!interaction.replied && !interaction.deferred) {
        interaction
          .reply({ content: '💀 Something broke. Try again.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
    return;
  }
  if (interaction.isModalSubmit()) {
    try {
      if (interaction.customId === 'feedback_submit') await handleFeedbackSubmit(interaction);
    } catch (err) {
      console.error(`[interaction] modal error: ${err.message}`);
      if (!interaction.replied && !interaction.deferred) {
        interaction
          .reply({ content: '💀 Something broke. Try again.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
    return;
  }
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
      case 'feedback':
        return showFeedbackModal(interaction);
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
      case 'prize':
        return interaction.reply(payloadPrize(interaction.user));
      case 'prizefor': {
        if (!isAdmin(interaction.user.id, interaction.member)) {
          return interaction.reply({ content: '🔒 Admin-only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser('user');
        const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
        return interaction.editReply(
          await actionPrizeFor({
            targetId: target.id,
            targetName: member?.displayName ?? target.username,
            attachment: interaction.options.getAttachment('image'),
            notes: interaction.options.getString('notes'),
            setBy: interaction.user.id,
          })
        );
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

// Personal, "just for me" commands that clutter the achievement feed. In that
// channel we auto-remove both the command and Survivor's reply after achCleanupMs
// so it stays a clean stream of achievements/milestones. Admin actions are left
// visible. (!feedback also self-removes the instant feedback is submitted — see
// handleFeedbackSubmit — this is just the fallback for an unused prompt.)
const ACH_EPHEMERAL_CMDS = new Set([
  '!help', '!commands', '!points', '!stats', '!card', '!rank',
  '!leaderboard', '!achievements', '!progress', '!link', '!unlink',
  '!prize', '!feedback', '!suggest',
]);

// Run a command in the achievement channel, then delete the command + Survivor's
// reply after achCleanupMs. Captures the reply by briefly wrapping message.reply
// (the ephemeral commands all answer that way). Needs Manage Messages.
async function runEphemeralCommand(message) {
  const sent = [];
  const origReply = message.reply.bind(message);
  message.reply = async (...a) => {
    const m = await origReply(...a);
    if (m) sent.push(m);
    return m;
  };
  try {
    await handleCommand(message);
  } finally {
    delete message.reply; // restore the prototype method
  }
  setTimeout(() => {
    message.delete().catch(() => {});
    for (const m of sent) m.delete().catch(() => {});
  }, achCleanupMs);
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  // A prize-setup follow-up may be a bare number or an image with no text, so
  // don't bail on empty content until we've given the flow a chance to consume it.
  const blank = !message.content?.trim();

  try {
    // Admins mid-`!prizefor` are in a short multi-step flow whose follow-ups
    // (a number, then an image) aren't ! commands — intercept them first so the
    // achievements-channel cleaner doesn't delete them.
    if (prizeFlows.has(prizeFlowKey(message))) {
      if (await continuePrizeFlow(message)) return;
    }
    if (blank) return;

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
        const cmd = message.content.trim().split(/\s+/)[0].toLowerCase();
        if (achCleanupMs > 0 && ACH_EPHEMERAL_CMDS.has(cmd)) {
          await runEphemeralCommand(message);
        } else {
          await handleCommand(message);
        }
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
      // Linked players only — Survivor doesn't trade survival tips with ghosts.
      if (!db.getPlayer(message.author.id)?.steam_id) {
        await deleteAndNotify(
          message,
          `🌲 <@${message.author.id}> link your Steam first to talk to me here — ` +
            `run \`!link <steamid64>\` in the achievements channel (or my DMs).`
        );
        return;
      }
      const budget = spendChatBudget(message.author.id);
      if (!budget.allowed) {
        // Don't delete their message — just tell them once, then stay quiet until
        // their budget replenishes (the count keeps rolling on its own).
        if (!budgetNotified.has(message.author.id)) {
          budgetNotified.add(message.author.id);
          await message.reply({
            content:
              `🪵 <@${message.author.id}> you've used your ${CHAT_BUDGET} messages this hour — ` +
              `give the forest a rest (try again in ~${budget.retryMinutes} min).`,
            allowedMentions: { users: [message.author.id], repliedUser: true },
          });
        }
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
      `backfill: ${backfillOn ? 'on' : 'off'} | all-games: ${trackAllGames ? 'on' : 'off'}`
  );

  seedFromEnv();
  loadChatHistory();
  await registerSlashCommands();
  startRecapScheduler();
  await backfillLinkRole();
  await initVoiceTracking();

  await pollAllPlayers();
  const interval = Number(POLL_INTERVAL_MS) || 300000;
  setInterval(pollAllPlayers, interval);
  console.log(`⏱️  Polling Steam every ${Math.round(interval / 1000)}s`);
});

client.login(DISCORD_BOT_TOKEN);

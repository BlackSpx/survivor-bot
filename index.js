// Survivor — Discord bot for a small The Forest friend group.
// Tracks Steam achievements (The Forest + Sons of the Forest), awards points,
// assigns reward roles, chats in a locked channel, and more.

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';

import * as db from './src/db.js';
import { getPlayerAchievements, getPlayerSummary } from './src/steam.js';
import * as survivor from './src/survivor.js';
import * as health from './src/health.js';
import { REWARDS, milestonesCrossed, rewardForPoints } from './src/rewards.js';
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
} = process.env;

const POINTS_PER_ACHIEVEMENT = 10;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
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

    for (const ach of achievements) {
      if (!ach.achieved) continue;
      if (db.hasAchievement(player.discord_id, appId, ach.apiname)) continue;

      db.recordAchievement(
        player.discord_id,
        appId,
        ach.apiname,
        ach.displayName,
        ach.unlockTime,
        1 // awarded
      );

      const before = db.getPlayer(player.discord_id).points;
      const after = db.addPoints(player.discord_id, POINTS_PER_ACHIEVEMENT);
      await announceAchievement(channel, name, ach.displayName, gameName(appId), after);
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

async function announceAchievement(channel, name, achievementName, game, total) {
  const comment = await survivor.commentOnAchievement(name, achievementName);
  const embed = new EmbedBuilder()
    .setColor(0x4caf50)
    .setDescription(
      `🏆 **${name}** just unlocked "**${achievementName}**"! _(${game})_\n\n` +
        `${comment}\n\n` +
        `**+${POINTS_PER_ACHIEVEMENT} pts** | Total: **${total} pts**`
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

  await message.reply(reply);
}

// ── Command logic (shared by ! prefix and / slash commands) ──────────────────

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

async function payloadSurvey() {
  const question = await survivor.askGroupQuestion();
  return { content: `📋 **Survivor's question of the day:**\n${question}` };
}

async function actionLink(userId, username, steamId) {
  if (!steamId || !/^\d{17}$/.test(steamId)) {
    return {
      content:
        'That needs to be a 17-digit SteamID64. Find yours at https://steamid.io/',
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
  db.linkPlayer(userId, steamId);
  const summary = await getPlayerSummary(steamId);
  if (summary?.personaname) db.setSteamName(userId, summary.personaname);
  return {
    content:
      `🔗 Linked **${username}** to Steam${summary?.personaname ? ` account **${summary.personaname}**` : ''}. ` +
      `Go unlock something — I'm watching.`,
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

// ── Prefix (!) commands ──────────────────────────────────────────────────────

function isAdmin(member) {
  return !!member?.permissions?.has(PermissionFlagsBits.Administrator);
}

async function handleCommand(message) {
  const [command, ...args] = message.content.trim().split(/\s+/);
  const cmd = command.toLowerCase();

  switch (cmd) {
    case '!points':
      await message.reply(await payloadPoints(message.author.id, message.author.username));
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
    case '!link':
      await message.reply(await actionLink(message.author.id, message.author.username, args[0]));
      return true;
    case '!unlink':
      await message.reply(actionUnlink(message.author.id, message.author.username));
      return true;
    case '!survey': {
      const p = await payloadSurvey();
      await message.channel.send(p.content);
      return true;
    }
    case '!addpoints':
    case '!setpoints': {
      if (!isAdmin(message.member)) {
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
      return false;
  }
}

// ── Slash (/) commands ───────────────────────────────────────────────────────

function buildSlashCommands() {
  return [
    new SlashCommandBuilder().setName('points').setDescription('Show your points'),
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
      case 'points':
        return interaction.reply(await payloadPoints(interaction.user.id, interaction.user.username));
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
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
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

    if (message.content.startsWith('!')) {
      const handled = await handleCommand(message);
      if (handled) return;
    }

    // Survivor only converses in his one designated channel.
    if (SURVIVOR_CHAT_CHANNEL_ID && message.channel.id === SURVIVOR_CHAT_CHANNEL_ID) {
      if (onCooldown(message.author.id)) return; // spam guard
      await converse(message);
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

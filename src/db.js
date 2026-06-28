// SQLite persistence for points, achievements, chat memory, and bot metadata.
// Uses better-sqlite3 (synchronous, fast, zero-config).

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATABASE_PATH lets a host (e.g. Railway) point the DB at a persistent volume
// so data survives redeploys. Falls back to a local file for dev.
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'survivor.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    discord_id     TEXT PRIMARY KEY,
    steam_id       TEXT UNIQUE,
    steam_name     TEXT,
    points         INTEGER NOT NULL DEFAULT 0,
    last_milestone INTEGER NOT NULL DEFAULT 0,
    seeded         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS achievements (
    discord_id   TEXT NOT NULL,
    game_id      TEXT NOT NULL DEFAULT '',
    apiname      TEXT NOT NULL,
    display_name TEXT,
    unlocked_at  INTEGER NOT NULL,
    awarded      INTEGER NOT NULL DEFAULT 1,
    recorded_at  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (discord_id, game_id, apiname)
  );

  CREATE TABLE IF NOT EXISTS chat_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    ts         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Migrations (add columns to existing tables without losing data) ──────────
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
// Daily unlock streaks. last_unlock_day is an integer day number (UTC).
ensureColumn('players', 'current_streak', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('players', 'best_streak', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('players', 'last_unlock_day', 'INTEGER');

// ── Players ────────────────────────────────────────────────────────────────

const upsertLinkStmt = db.prepare(`
  INSERT INTO players (discord_id, steam_id)
  VALUES (@discord_id, @steam_id)
  ON CONFLICT(discord_id) DO UPDATE SET steam_id = excluded.steam_id
`);
export function linkPlayer(discordId, steamId) {
  upsertLinkStmt.run({ discord_id: discordId, steam_id: steamId });
}

const unlinkStmt = db.prepare(
  'UPDATE players SET steam_id = NULL, steam_name = NULL WHERE discord_id = ?'
);
export function unlinkPlayer(discordId) {
  return unlinkStmt.run(discordId).changes > 0;
}

const ensurePlayerStmt = db.prepare(
  'INSERT OR IGNORE INTO players (discord_id) VALUES (?)'
);
/** Make sure a player row exists (used before admin point adjustments). */
export function ensurePlayer(discordId) {
  ensurePlayerStmt.run(discordId);
}

const getPlayerStmt = db.prepare('SELECT * FROM players WHERE discord_id = ?');
export function getPlayer(discordId) {
  return getPlayerStmt.get(discordId);
}

const getPlayerBySteamIdStmt = db.prepare(
  'SELECT * FROM players WHERE steam_id = ?'
);
export function getPlayerBySteamId(steamId) {
  return getPlayerBySteamIdStmt.get(steamId);
}

const getLinkedPlayersStmt = db.prepare(
  "SELECT * FROM players WHERE steam_id IS NOT NULL AND steam_id != ''"
);
export function getLinkedPlayers() {
  return getLinkedPlayersStmt.all();
}

const getLeaderboardStmt = db.prepare(
  'SELECT * FROM players ORDER BY points DESC, discord_id ASC'
);
export function getLeaderboard() {
  return getLeaderboardStmt.all();
}

const setSteamNameStmt = db.prepare(
  'UPDATE players SET steam_name = ? WHERE discord_id = ?'
);
export function setSteamName(discordId, name) {
  setSteamNameStmt.run(name, discordId);
}

const addPointsStmt = db.prepare(
  'UPDATE players SET points = MAX(0, points + ?) WHERE discord_id = ?'
);
export function addPoints(discordId, amount) {
  addPointsStmt.run(amount, discordId);
  return getPlayer(discordId).points;
}

const setPointsStmt = db.prepare(
  'UPDATE players SET points = ? WHERE discord_id = ?'
);
export function setPoints(discordId, value) {
  setPointsStmt.run(Math.max(0, value), discordId);
  return getPlayer(discordId).points;
}

const setMilestoneStmt = db.prepare(
  'UPDATE players SET last_milestone = ? WHERE discord_id = ?'
);
export function setLastMilestone(discordId, milestone) {
  setMilestoneStmt.run(milestone, discordId);
}

const markSeededStmt = db.prepare('UPDATE players SET seeded = 1 WHERE discord_id = ?');
export function markSeeded(discordId) {
  markSeededStmt.run(discordId);
}

// ── Achievements ───────────────────────────────────────────────────────────

const hasAchievementStmt = db.prepare(
  'SELECT 1 FROM achievements WHERE discord_id = ? AND game_id = ? AND apiname = ?'
);
export function hasAchievement(discordId, gameId, apiname) {
  return !!hasAchievementStmt.get(discordId, gameId, apiname);
}

const recordAchievementStmt = db.prepare(`
  INSERT OR IGNORE INTO achievements
    (discord_id, game_id, apiname, display_name, unlocked_at, awarded, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
export function recordAchievement(
  discordId,
  gameId,
  apiname,
  displayName,
  unlockedAt,
  awarded = 1
) {
  recordAchievementStmt.run(
    discordId,
    gameId,
    apiname,
    displayName,
    unlockedAt,
    awarded ? 1 : 0,
    Date.now()
  );
}

const getAchievementsStmt = db.prepare(
  'SELECT * FROM achievements WHERE discord_id = ? ORDER BY unlocked_at ASC'
);
export function getAchievements(discordId) {
  return getAchievementsStmt.all(discordId);
}

// How many distinct players have ever recorded a given achievement. Used to
// detect "First Blood" — the first member of the group to unlock something.
const achievementOwnerCountStmt = db.prepare(
  'SELECT COUNT(DISTINCT discord_id) AS n FROM achievements WHERE game_id = ? AND apiname = ?'
);
export function achievementOwnerCount(gameId, apiname) {
  return achievementOwnerCountStmt.get(gameId, apiname).n;
}

// ── Streaks ──────────────────────────────────────────────────────────────────

const updateStreakStmt = db.prepare(
  'UPDATE players SET current_streak = ?, best_streak = ?, last_unlock_day = ? WHERE discord_id = ?'
);
/**
 * Record that a player unlocked something on integer day `day` (UTC day number)
 * and update their streak. Returns { current, best, extended } where `extended`
 * is true only when this unlock pushed an existing streak to a new day.
 */
export function recordUnlockDay(discordId, day) {
  const p = getPlayer(discordId);
  const prevBest = p.best_streak || 0;
  const last = p.last_unlock_day;

  if (last === day) {
    return { current: p.current_streak || 0, best: prevBest, extended: false };
  }
  const current = last === day - 1 ? (p.current_streak || 0) + 1 : 1;
  const best = Math.max(prevBest, current);
  updateStreakStmt.run(current, best, day, discordId);
  return { current, best, extended: last === day - 1 };
}

// Points-earning achievements unlocked since a timestamp, grouped by player.
const weeklyStatsStmt = db.prepare(`
  SELECT discord_id, COUNT(*) AS count
  FROM achievements
  WHERE awarded = 1 AND recorded_at >= ?
  GROUP BY discord_id
  ORDER BY count DESC
`);
export function getStatsSince(sinceTs) {
  return weeklyStatsStmt.all(sinceTs);
}

// ── Chat history (persistent conversation memory) ────────────────────────────

const appendChatStmt = db.prepare(
  'INSERT INTO chat_history (channel_id, role, content, ts) VALUES (?, ?, ?, ?)'
);
export function appendChat(channelId, role, content) {
  appendChatStmt.run(channelId, role, content, Date.now());
}

const getRecentChatStmt = db.prepare(
  'SELECT role, content FROM chat_history WHERE channel_id = ? ORDER BY id DESC LIMIT ?'
);
/** Most recent messages for a channel, returned oldest-first. */
export function getRecentChat(channelId, limit) {
  return getRecentChatStmt.all(channelId, limit).reverse();
}

const trimChatStmt = db.prepare(`
  DELETE FROM chat_history
  WHERE channel_id = ?
    AND id NOT IN (
      SELECT id FROM chat_history WHERE channel_id = ? ORDER BY id DESC LIMIT ?
    )
`);
export function trimChat(channelId, keep) {
  trimChatStmt.run(channelId, channelId, keep);
}

// ── Backup / export ──────────────────────────────────────────────────────────

// WAL-safe online backup: produces a consistent copy even while the bot writes.
// Returns a Promise (better-sqlite3's backup is async).
export function backupDatabase(destPath) {
  return db.backup(destPath);
}

// Flat snapshot of every player — the human-readable data you'd need to rebuild
// points/links by hand if the .db file itself were ever lost or corrupted.
const exportPlayersStmt = db.prepare(`
  SELECT discord_id, steam_id, steam_name, points,
         current_streak, best_streak, last_milestone
  FROM players
  ORDER BY points DESC, discord_id ASC
`);
export function exportPlayers() {
  return exportPlayersStmt.all();
}

// ── Meta (key/value bot state) ───────────────────────────────────────────────

const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
export function getMeta(key) {
  return getMetaStmt.get(key)?.value ?? null;
}

const setMetaStmt = db.prepare(`
  INSERT INTO meta (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
export function setMeta(key, value) {
  setMetaStmt.run(key, String(value));
}

export default db;

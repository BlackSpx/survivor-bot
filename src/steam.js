// Thin wrapper around the Steam Web API.

import * as health from './health.js';

const API_KEY = process.env.STEAM_API_KEY;

/**
 * Fetch a player's achievements for a given game (Steam App ID).
 * Returns an array of { apiname, displayName, achieved, unlockTime }, or null
 * when the data can't be read (private profile, game not owned, Steam outage).
 *
 * A private profile / not-owned game (HTTP 403) is *expected* and does NOT count
 * as a health failure; network errors and 5xx do.
 */
export async function getPlayerAchievements(steamId, appId) {
  const url =
    `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/` +
    `?appid=${appId}&key=${API_KEY}&steamid=${steamId}&l=english`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    health.reportError('Steam', err.message);
    return null;
  }

  if (!res.ok) {
    if (res.status >= 500) health.reportError('Steam', `HTTP ${res.status}`);
    // 403 = private/not owned — quietly skip, not a service failure.
    return null;
  }

  health.reportOk('Steam');

  const data = await res.json();
  if (!data?.playerstats?.success || !Array.isArray(data.playerstats.achievements)) {
    return null; // usually a private profile
  }

  return data.playerstats.achievements.map((a) => ({
    apiname: a.apiname,
    displayName: a.name || a.apiname,
    achieved: a.achieved === 1,
    unlockTime: a.unlocktime ? a.unlocktime * 1000 : Date.now(),
  }));
}

// Global achievement rarity (% of all owners who have each achievement).
// Cached per game — these percentages barely move, so we refresh infrequently
// to avoid hammering Steam on every poll cycle.
const rarityCache = new Map(); // appId -> { ts, map }
const RARITY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Returns a Map of apiname -> ownership percentage (0–100) for a game, or null
 * if it can't be read. Stale cache is preferred over null on a transient error.
 */
export async function getGlobalAchievementPct(appId) {
  const cached = rarityCache.get(appId);
  if (cached && Date.now() - cached.ts < RARITY_TTL_MS) return cached.map;

  const url =
    `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/` +
    `?gameid=${appId}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status >= 500) health.reportError('Steam', `HTTP ${res.status}`);
      return cached?.map ?? null;
    }
    const data = await res.json();
    const arr = data?.achievementpercentages?.achievements;
    if (!Array.isArray(arr)) return cached?.map ?? null;
    const map = new Map();
    for (const a of arr) map.set(a.name, Number(a.percent));
    rarityCache.set(appId, { ts: Date.now(), map });
    return map;
  } catch (err) {
    health.reportError('Steam', err.message);
    return cached?.map ?? null;
  }
}

/**
 * Fetch a player's profile summary: display name + the App ID they're currently
 * in-game on (if any). Returns { personaname, gameId } or null on failure.
 */
export async function getPlayerSummary(steamId) {
  const url =
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/` +
    `?key=${API_KEY}&steamids=${steamId}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status >= 500) health.reportError('Steam', `HTTP ${res.status}`);
      return null;
    }
    health.reportOk('Steam');
    const data = await res.json();
    const player = data?.response?.players?.[0];
    if (!player) return null;
    return {
      personaname: player.personaname ?? null,
      gameId: player.gameid ?? null, // present only while in-game
    };
  } catch (err) {
    health.reportError('Steam', err.message);
    return null;
  }
}

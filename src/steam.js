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

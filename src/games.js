// Games the bot tracks achievements for. Add more by extending this map
// (key = Steam App ID, value = display name).

export const GAMES = {
  '242760': { name: 'The Forest' },
  '1326470': { name: 'Sons of the Forest' },
};

export const TRACKED_APP_IDS = Object.keys(GAMES);

// Names learned at runtime for games NOT in GAMES — populated from Steam's
// "recently played" data when TRACK_ALL_GAMES is on, so announcements for other
// games read with a real title instead of a bare App ID.
const dynamicNames = new Map();

export function rememberGameName(appId, name) {
  if (appId != null && name) dynamicNames.set(String(appId), name);
}

export function gameName(appId) {
  return GAMES[appId]?.name ?? dynamicNames.get(String(appId)) ?? `App ${appId}`;
}

// Games the bot tracks achievements for. Add more by extending this map
// (key = Steam App ID, value = display name).

export const GAMES = {
  '242760': { name: 'The Forest' },
  '1326470': { name: 'Sons of the Forest' },
};

export const TRACKED_APP_IDS = Object.keys(GAMES);

export function gameName(appId) {
  return GAMES[appId]?.name ?? `App ${appId}`;
}

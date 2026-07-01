// The entry role every player gets the moment they link a Steam account (0 pts).
// It sits below all the point-milestone rewards below and is meant to be the
// role you lock the survivor/achievement/voice channels to, so only linked
// players can join. Lock channels to this role's NAME in Discord's permissions.
export const LINK_ROLE = { emoji: '🪂', name: 'Castaway', role: 'Castaway' };

// Hardcoded milestone rewards. Each entry maps a point threshold to a
// reward label and the Discord role name that gets assigned at that threshold.

export const REWARDS = [
  { points: 100, emoji: '🎖️', name: 'Forest Rookie', role: 'Forest Rookie' },
  { points: 200, emoji: '🪓', name: 'Axe Master', role: 'Axe Master' },
  { points: 300, emoji: '🏠', name: 'Base Builder', role: 'Base Builder' },
  { points: 500, emoji: '👑', name: 'Forest Legend', role: 'Forest Legend' },
];

/**
 * Every 100-point milestone newly crossed between two totals.
 * e.g. 90 -> 320 returns [100, 200, 300]. Handles big jumps from a single poll.
 */
export function milestonesCrossed(oldPoints, newPoints) {
  const crossed = [];
  const first = Math.floor(oldPoints / 100) * 100 + 100;
  for (let m = first; m <= newPoints; m += 100) crossed.push(m);
  return crossed;
}

/** The role reward defined at a given milestone, or null (e.g. 400, 600...). */
export function rewardForPoints(points) {
  return REWARDS.find((r) => r.points === points) ?? null;
}

// ── Rarity bonuses ───────────────────────────────────────────────────────────
// Steam exposes the global % of owners who have each achievement. The rarer the
// unlock, the bigger the bonus. Tiers are checked in order (lowest % first).
export const RARITY_TIERS = [
  { maxPct: 2, bonus: 30, label: 'Mythic', emoji: '💎' },
  { maxPct: 10, bonus: 15, label: 'Rare', emoji: '🟣' },
  { maxPct: 25, bonus: 5, label: 'Uncommon', emoji: '🔵' },
];

/** The rarity tier for a global ownership %, or null if common / unknown. */
export function rarityTier(pct) {
  if (pct == null || Number.isNaN(pct)) return null;
  return RARITY_TIERS.find((t) => pct <= t.maxPct) ?? null;
}

// ── Voice activity milestones ────────────────────────────────────────────────
// Time spent together in the game voice channel earns points at these cumulative
// hour thresholds, ranking a player from newbie to veteran. Each is announced in
// the achievement channel and the points feed straight into the normal totals
// (so they can also trip the 100/200/300/500 role rewards above).
export const VOICE_MILESTONES = [
  { hours: 1, points: 20, emoji: '🎙️', label: 'Voice Newbie' },
  { hours: 5, points: 40, emoji: '🗣️', label: 'Voice Regular' },
  { hours: 10, points: 75, emoji: '🔥', label: 'Voice Veteran' },
  { hours: 25, points: 150, emoji: '👑', label: 'Voice Legend' },
];

/**
 * Every voice milestone crossed between two cumulative voice-hour totals
 * (fractional hours). e.g. 0.5 -> 6 returns the 1h and 5h milestones.
 */
export function voiceMilestonesCrossed(oldHours, newHours) {
  return VOICE_MILESTONES.filter((m) => m.hours > oldHours && m.hours <= newHours);
}

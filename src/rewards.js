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

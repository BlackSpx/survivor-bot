// Lightweight health monitor. Tracks consecutive failures per external service
// (Steam, Gemini) and fires a single alert when one goes down, plus a recovery
// note when it comes back. index.js wires `setNotifier` to a Discord channel.

const THRESHOLD = 3; // consecutive failures before we alert
const state = new Map(); // service -> { failures, down }

let notifier = null;

/** index.js registers how alerts get delivered (e.g. post to a log channel). */
export function setNotifier(fn) {
  notifier = fn;
}

function get(service) {
  if (!state.has(service)) state.set(service, { failures: 0, down: false });
  return state.get(service);
}

function notify(text) {
  if (notifier) {
    try {
      notifier(text);
    } catch {
      /* ignore notifier errors */
    }
  } else {
    console.warn('[health]', text);
  }
}

export function reportOk(service) {
  const s = get(service);
  if (s.down) {
    s.down = false;
    notify(`✅ **${service}** is back to normal.`);
  }
  s.failures = 0;
}

export function reportError(service, message = '') {
  const s = get(service);
  s.failures += 1;
  if (!s.down && s.failures >= THRESHOLD) {
    s.down = true;
    notify(`⚠️ **${service}** is failing (${s.failures}× in a row). Latest: ${message}`);
  }
}

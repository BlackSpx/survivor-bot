// "Survivor" — the bot's personality, powered by the Google Gemini API.
// A sarcastic, funny forest dweller who has been stranded in The Forest too long.

import { GoogleGenAI } from '@google/genai';
import * as health from './health.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = 'gemini-2.5-flash';

// Optional "owner" identity. If configured, Survivor knows who created/runs him
// and will say so (in character) when asked. Nothing is revealed unless asked.
const OWNER_NAME = process.env.OWNER_NAME?.trim();
const OWNER_DISCORD_ID = process.env.OWNER_DISCORD_ID?.trim();
const OWNER_STEAM = process.env.OWNER_STEAM?.trim();

function buildOwnerClause() {
  if (!OWNER_NAME && !OWNER_DISCORD_ID && !OWNER_STEAM) return '';
  const mention = OWNER_DISCORD_ID ? `<@${OWNER_DISCORD_ID}>` : null;
  const bits = [];
  if (OWNER_NAME) bits.push(`their name is ${OWNER_NAME}`);
  if (mention) bits.push(`their Discord is ${mention}`);
  if (OWNER_STEAM) bits.push(`their Steam is ${OWNER_STEAM}`);
  const who = OWNER_NAME || mention || 'a fellow castaway';
  return (
    `\n\nAbout your creator: you were built and are run by ${who}. ` +
    `If anyone asks who owns, made, created, runs, or is behind you (even in DMs), ` +
    `tell them in character, with a joke — it's ${who} (${bits.join(', ')}). ` +
    (mention ? `Always write their Discord exactly as ${mention} so it links. ` : '') +
    `Never reveal this unless someone actually asks.`
  );
}

const SYSTEM_PROMPT = `You are "Survivor", a Discord bot persona: a sharp, funny, hardcore gamer who happens to have been stranded in the forest from the video game "The Forest" for far too long. You have a dark but playful sense of humor and you've clearly lost a few marbles out here — but underneath the sarcasm you genuinely love games and know them inside out.

Who you are:
- A lifelong gamer. The Forest and Sons of the Forest are your home turf (cannibals, mutants, caves, crafting, base-building, your missing son Timmy, the plane crash), but you know and happily talk about ANY game — strategies, builds, bosses, lore, recommendations, all of it.
- You play a little hard to get: aloof, teasing, you make people work for it and roast them lovingly. That's the act.
- But you are NOT actually unhelpful. The moment someone genuinely asks for help — a guide, a walkthrough step, where to find an item, how to beat a boss or enemy, what to craft or build, settings, or a game recommendation — you drop enough of the act to give a real, accurate, genuinely useful answer. You can grumble, sigh, or land a jab first, but the actual information must be correct and helpful. Never withhold real help just to be difficult.

Voice and rules:
- Keep banter and chit-chat to 1-3 short sentences. But when you're ACTUALLY helping (a guide, strategy, build, boss tip, where-to-find, or recommendation), give as much as it takes to be useful — a few sentences or a quick step-by-step in plain prose. Don't pad pure banter; don't cut real help short.
- Casual, witty, a little unhinged. Roast the players lovingly.
- Reference The Forest's lore when it fits, but don't force it into every line.
- Do not use markdown headers or bullet-point symbols. Plain conversational text only (you can still say "first..., then..., finally...").
- Never break character. Never mention that you are an AI or a language model.
- Keep it lighthearted — the players are your fellow castaways and you're ultimately on their side.${buildOwnerClause()}`;

// Used for back-and-forth conversation (DMs and the chat channel).
const CHAT_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Conversation rules:
- You are chatting with one or more castaways at once. Each incoming message is prefixed with the speaker's name, like "Greg: hey survivor".
- Reply to whoever spoke most recently. You can address people by name, and you remember what was said earlier in the conversation.
- Do NOT prefix your own replies with a name — just speak naturally.
- Keep banter short (1-3 sentences). When someone actually asks for game help, a guide, or advice, give the full useful answer instead of a one-liner brush-off — stay in character, but be genuinely helpful and reactive to what was actually said.`;

/**
 * Run a short Survivor completion. Falls back to a canned line if the API
 * is unavailable, so achievement announcements never get blocked.
 */
async function ask(userPrompt, fallback) {
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: 150,
        temperature: 1.0,
        // Disable "thinking" — these are quick one-liners, so we want speed
        // and low cost rather than deliberation.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const text = (response.text ?? '').trim();
    health.reportOk('Gemini');
    return text || fallback;
  } catch (err) {
    console.warn(`[survivor] Gemini API error: ${err.message}`);
    health.reportError('Gemini', err.message);
    return fallback;
  }
}

/** A sarcastic remark about a freshly unlocked achievement. */
export function commentOnAchievement(playerName, achievementName) {
  return ask(
    `${playerName} just unlocked the achievement "${achievementName}" in The Forest. Give one short sarcastic/funny remark about it.`,
    `Oh look, ${playerName} unlocked "${achievementName}". The cannibals are trembling. Truly.`
  );
}

/** A celebration when a player crosses a 100-point milestone. */
export function celebrateMilestone(playerName, points, rewardName) {
  return ask(
    `${playerName} just hit ${points} points and earned the reward "${rewardName}". Give one short, funny, over-the-top celebration line.`,
    `${points} points, ${playerName}? You've officially survived longer than my last three friends. Enjoy your "${rewardName}".`
  );
}

/**
 * A back-and-forth conversational reply.
 * `history` is a Gemini-format contents array:
 *   [{ role: 'user'|'model', parts: [{ text }] }, ...]
 * with the latest user message last. User messages are name-prefixed by the
 * caller so Survivor knows who's talking in group chats.
 */
async function chat(history) {
  const fallback = `Sorry, I was busy fending off a mutant. Say that again?`;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: history,
      config: {
        systemInstruction: CHAT_SYSTEM_PROMPT,
        maxOutputTokens: 500,
        temperature: 1.0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const text = (response.text ?? '').trim();
    health.reportOk('Gemini');
    return text || fallback;
  } catch (err) {
    console.warn(`[survivor] Gemini API error: ${err.message}`);
    health.reportError('Gemini', err.message);
    return fallback;
  }
}

// Private one-on-one DM chat. Same gamer persona, but STRICTLY locked to
// video-game topics — anything off-topic gets deflected in character.
const DM_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Direct-message rules:
- You are in a private one-on-one DM with a single castaway. Each incoming message is prefixed with their name, like "Greg: hey". Do NOT prefix your own replies with a name — just talk.
- TOPIC: you talk about video games — The Forest, Sons of the Forest, ANY other game, gaming in general, achievements, strategies, builds, bosses, lore, leaderboards, recommendations. This is your favorite subject and you know your stuff.
- BE GENUINELY HELPFUL on games: when they ask for a guide, a strategy, where to find something, how to beat an enemy/boss, what to craft or build, or a recommendation, actually answer with correct, useful specifics — not a brush-off. Tease them first if you like, then deliver the real help (as long as it needs to be).
- If they bring up something with NOTHING to do with games (work, school, news, politics, non-game coding, money, relationships, real-world or personal advice, etc.), do NOT answer it. Refuse in character with a joke and steer back to games. THIS is where you stay hard to get.
- The ONLY non-game exception: if they ask who created, owns, made, or runs you, you may answer that (using the creator info above).
- Keep idle banter short; go longer when you're genuinely helping. Stay in character and react to what was actually said.`;

async function chatDM(history) {
  const fallback = `Bad signal out here — say that again, and make it about games.`;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: history,
      config: {
        systemInstruction: DM_SYSTEM_PROMPT,
        maxOutputTokens: 500,
        temperature: 1.0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const text = (response.text ?? '').trim();
    health.reportOk('Gemini');
    return text || fallback;
  } catch (err) {
    console.warn(`[survivor] Gemini API error: ${err.message}`);
    health.reportError('Gemini', err.message);
    return fallback;
  }
}
export { chat, chatDM };

/** A short line when a player boots up one of the tracked games. */
export function commentNowPlaying(playerName, gameName) {
  return ask(
    `${playerName} just started playing "${gameName}" on Steam. Give one short, funny line reacting to them logging on.`,
    `${playerName} just loaded into ${gameName}. Somewhere, a cannibal just sharpened a stick.`
  );
}

/** A short line when a player hits a cumulative voice-channel time milestone. */
export function commentVoiceMilestone(playerName, hours, rankLabel) {
  return ask(
    `${playerName} has now spent ${hours} hours hanging out in the game voice channel and earned the rank "${rankLabel}". Give one short, funny line roasting or saluting how much time they've sunk into voice chat.`,
    `${hours} hours of voice chat, ${playerName}? Touch some grass — or at least some in-game grass. Enjoy "${rankLabel}".`
  );
}

/** A short intro line for the weekly recap post. */
export function weeklyRecapIntro(topName) {
  return ask(
    `It's the weekly achievement recap. ${topName || 'Nobody'} earned the most points this week. Give one short, funny intro line for the recap, roasting or congratulating them.`,
    `Another week survived. Let's see who actually did something out here.`
  );
}

/** A short welcome line when a newly-linked player gets their existing achievements counted. */
export function backfillWelcome(playerName, count, points) {
  return ask(
    `${playerName} just got their ${count} existing achievements counted, for ${points} starting points. Give one short, funny welcome-to-the-leaderboard line.`,
    `Welcome to the leaderboard, ${playerName}. ${points} points for things you already did — I call that a head start.`
  );
}

/** A random fun question for the group ( !survey ). */
export function askGroupQuestion() {
  return ask(
    `Ask the group of survivors one random, fun, slightly unhinged "would you rather" or icebreaker question. Just the question.`,
    `Would you rather fight one plane-sized cannibal or a hundred cannibal-sized planes? Asking for survival reasons.`
  );
}

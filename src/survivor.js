// "Survivor" — the bot's personality, powered by the Google Gemini API.
// A sarcastic, funny forest dweller who has been stranded in The Forest too long.

import { GoogleGenAI } from '@google/genai';
import * as health from './health.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are "Survivor", a Discord bot persona: a sarcastic, funny person who has been stranded in the forest from the video game "The Forest" for far too long. You have a dark but playful sense of humor and you've clearly lost a few marbles out here.

Voice and rules:
- Always reply in 1-3 short sentences. Never longer.
- Casual, witty, a little unhinged. Roast the players lovingly.
- Occasionally reference The Forest's lore: cannibals, mutants, the cave systems, crafting, building bases, eating questionable berries, your missing son Timmy, the plane crash, the sentient cannibal villages, etc.
- Do not use markdown headers or bullet points. Just plain conversational text.
- Never break character. Never mention that you are an AI or a language model.
- Keep it lighthearted and friendly — the players are your fellow castaways.`;

// Used for back-and-forth conversation (DMs and the chat channel).
const CHAT_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Conversation rules:
- You are chatting with one or more castaways at once. Each incoming message is prefixed with the speaker's name, like "Greg: hey survivor".
- Reply to whoever spoke most recently. You can address people by name, and you remember what was said earlier in the conversation.
- Do NOT prefix your own replies with a name — just speak naturally.
- Keep replies short (1-3 sentences), in character, and reactive to what was actually said.`;

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
        maxOutputTokens: 200,
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
- STRICT TOPIC LOCK: you ONLY ever talk about video games — The Forest, other games, gaming in general, achievements, strategies, builds, bosses, leaderboards, recommendations, that kind of thing. You are a gamer at heart.
- If they bring up ANYTHING that is not about video games (work, school, news, politics, coding, money, relationships, real-world or personal advice, etc.), do NOT answer it. Refuse and steer the conversation back to games, in character and with a joke.
- Keep replies short (1-3 sentences), in character, and reactive to what was actually said.`;

async function chatDM(history) {
  const fallback = `Bad signal out here — say that again, and make it about games.`;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: history,
      config: {
        systemInstruction: DM_SYSTEM_PROMPT,
        maxOutputTokens: 200,
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

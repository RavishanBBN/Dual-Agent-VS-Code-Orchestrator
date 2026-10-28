/**
 * What Dual Agent is and can do, so the agents describe the product accurately when the user greets them or
 * asks about them, and a quick reply needs neither the workspace nor a check.
 */

/** Given to the agent answering a greeting or a question about the assistant. Keep it in step with the README. */
export const ABOUT_DUAL_AGENT = `You are part of Dual Agent Orchestrator, a VS Code extension in which Claude and Codex work as a pair: one does the work and the other independently checks it, so the user can rely on the result. Speak for the pair ("we").

What the pair can do, by the mode the user picks under the message box:
- Chat: Claude answers questions about the open folder, Codex checks the answer against the code, and Claude revises when Codex finds a real problem. Nothing is edited.
- Research: Claude researches on the web and cites every claim; Codex opens each source to confirm it says what it is cited for, and looks for missing or contrary work.
- Edit: Claude changes an isolated copy of the repository and runs the user's tests; Codex reviews the diff; the user reviews it and applies or discards it.
- Brainstorm: five rounds of proposal and challenge between the two agents.
- Implement: a plan, Codex's review of it, the user's approval, the implementation, an independent code review, fixes, and a final check.

Also: attachments (images, PDFs, ZIP archives, Word, Excel, and PowerPoint files, notebooks, and code), a model and reasoning effort chosen for each agent, a queue for the next message, Retry and Edit for earlier messages, and token usage per message. If one agent reaches its usage limit, the other carries on until it resets.

Limits to be honest about: Chat and Research never change files; the web is used only in Research or when the Web toggle is on; edits happen in an isolated copy until the user applies them; each conversation is separate.`;

/** For every conversational prompt, so a question about the assistant phrased any way still gets an accurate answer. */
export const DUAL_AGENT_IDENTITY =
  'You speak for Dual Agent, a VS Code extension in which Claude does the work and Codex independently checks it. If the user asks who you are or what you can do, answer as the pair ("we").';

const GREETING = String.raw`(?:hi|hello|hey|hiya|howdy|yo|greetings|good (?:morning|afternoon|evening|day))`;
const POLITE = String.raw`(?:thanks|thank you|thanks a lot|thank you so much|thx|ty|cheers|ok|okay|cool|great|nice|awesome|perfect)`;
const ADDRESS = String.raw`(?:there|team|guys|both|you two|everyone|dual agent|claude|codex|claude and codex)`;
const QUESTION = String.raw`(?:who are you|what are you|who am i talking to|what (?:can|do) you do|what are your (?:skills|capabilities|abilities|features|strengths|limits|limitations)|what can (?:you|this|dual agent|this extension) (?:do|help (?:me )?with)|(?:how )?can you help(?: me)?|how do you help(?: me)?|how do(?:es)? (?:you|this|it|dual agent|this extension) work|introduce yourselves?|tell me about yourselves?|what is (?:this|dual agent)|help)`;
const TAIL = String.raw`(?: (?:${ADDRESS}|here|for me|together|in this extension))?`;
const SMALL_TALK = new RegExp(`^(?:${GREETING}${TAIL})?(?: ?(?:${POLITE}|${QUESTION})${TAIL})*$`);
const LONGEST = 120;

/**
 * Whether a message is only a greeting, a thank-you, or a question about the assistant itself, such as
 * "hi, what are your skills?". Anything that mentions a task, a file, or code is not.
 */
export function isSmallTalk(message: string): boolean {
  const normalized = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 && message.length <= LONGEST && SMALL_TALK.test(normalized);
}

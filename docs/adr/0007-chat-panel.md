# ADR-0007: Conversational chat panel

**Status:** accepted; amends ADR-0005

**Date:** 2026-10-28

## Context

Release 2.0 used only native VS Code components (ADR-0005). That made the extension feel like part of VS Code, but every task was a single objective typed into an input box, followed by a fixed five- or seven-stage run. Users asked for an interface like Claude Code's: a conversation with follow-ups, attachments such as images, PDFs, and archives, and a visible choice of each agent's model and reasoning effort. They also wanted the pair of agents to be more useful than either one alone for everyday questions, not only for large tasks.

Native components cannot provide a conversation view with streamed Markdown, inline action cards, and an attachment composer. VS Code's chat participant API would show one, but only inside the Copilot Chat view, which would make the extension depend on another product and its sign-in. Claude Code's own panel is a webview.

## Decision

- **Chat panel.** Add a webview view, **Chat**, in its own container in the secondary side bar, where Claude Code places its panel, and available as an editor tab too. Keep the Runs and Agents views, documents, diff editors, status bar, and output channel native, and route every action in the chat to the same commands, consent, and single-run lock.
- **Four modes per message:**
  - **Chat:** Claude answers, then Codex checks the answer with a verdict, and Claude revises only when the check fails. It is read-only, with at most three calls.
  - **Edit:** Claude edits, verification commands run, Codex reviews the diff as a gate, and fix rounds follow, in a worktree the conversation keeps until the changes are applied or discarded.
  - **Brainstorm** and **Implement:** the existing workflows.
- **Conversations.** Store each conversation in its own file. Claude continues its session from message to message; Codex starts fresh with a budgeted history, so its checks stay independent. Each turn keeps its answer, so pruning old runs does not empty a conversation.
- **Attachments.** Copy attachments into private storage, unpack archives, and extract PDF and Office text, so both agents can use them: Claude through `--add-dir` and its Read tool, Codex through `--image` and the extracted text.
- **Models and effort.** Offer pickers in the composer. Claude uses its model aliases and `--effort`; Codex's models and their reasoning levels come from `codex debug models`. Choices are stored in `globalState`, never in settings a repository could supply.
- **Webview security.** Load nothing remote, use a nonce CSP, disable command URIs, render agent Markdown with raw HTML escaped and images disabled, let only checked links and in-folder files open, and validate every message from the page.

## Consequences

- AGENTS.md now allows exactly one webview, the chat, under the rules above.
- The page's logic lives in tested pure modules (protocol, transcript, Markdown). The Preact components and the controller are exercised by the smoke test, which loads the real page under its CSP and drives a conversation through the extension's test API.
- Three new runtime dependencies are bundled: Preact and markdown-it in the page, fflate in the host, and pdf.js (through unpdf) in a separate worker bundle loaded only for PDFs. Versions are pinned and audited.
- Chat costs two agent calls per message when Codex agrees. That is deliberate: the check is what makes the answer more reliable than either agent alone.

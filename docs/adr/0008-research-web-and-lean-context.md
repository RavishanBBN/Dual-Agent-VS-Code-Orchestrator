# ADR-0008: Research mode, web access, and lean context

**Status:** accepted

**Date:** 2026-10-28

## Context

Most of the user's work is research: finding research gaps, reading papers, and checking claims against sources. That needs the web, and it needs the sources to be real and to say what they are cited for. Until now, read-only stages could only read the workspace. Claude Code's WebSearch and WebFetch tools were excluded on purpose, because a page or a repository file could steer an agent into sending data out through a URL.

Measurements of real runs also showed where tokens go. Each agent re-reads its whole prompt on every step of a stage, so a large workspace snapshot is paid for many times. Codex's check re-explored files Claude had already read. Chat answers carried workflow boilerplate written for stage reports, and a check that found only low-severity notes still cost a full Claude revision.

## Decision

- **Research mode:**
  - Claude researches with the web, the attachments, and the workspace. It reads every source before citing it, cites each claim inline, and separates what is established, contested, and unknown, giving its confidence in each.
  - Codex then opens every cited source, confirms it exists and supports its claim, and searches for missing or contrary work.
  - Claude revises when the check fails, keeping only sources it has confirmed.
  - Both agents use high reasoning effort unless the user chooses another.
- **Web access is explicit:**
  - Research stages always have the web.
  - Other modes have it only when the user turns on the composer's **Web** toggle for the message.
  - Claude gets the WebSearch and WebFetch tools; Codex runs with its top-level `--search` flag.
  - Nothing else changes: read-only stages still cannot run commands or edit files.
- **Lean context:** Chat, Research, and Brainstorm stages get the workspace as a summary: status, the diff summary, at most 8,000 characters of diff, and untracked files by name. Editing and review stages in Edit and Implement keep the full diff they review.
- **Evidence trail:** every stage after another sees the previous stage's steps, such as files read, searches, and commands with their failures, fenced as untrusted. Reviewers are told to check specific claims and look at what was not examined, instead of re-exploring.
- **Answers for the reader:** in conversations, answers lead with the result, are as short as the question allows, and contain no stage-report sections; a passing check is at most two sentences.
- **Minor notes stay notes:** a chat or research check that fails with only low-severity findings keeps the answer and shows the notes. Gates in Edit and Implement are unchanged.
- **First-shot edits:**
  - Editing stages may run the user's verification commands themselves, as Claude Code prefix rules built only from arguments that need no quoting.
  - If the checks still fail after an editing stage, one Claude repair runs before the review, so the reviewer sees working code.

## Consequences

- Web access lets search terms, page requests, and anything an agent puts in a URL leave the machine, and lets web pages reach the agents' context. It is off by default outside Research, shown on the composer, fenced as untrusted, and documented in SECURITY.md.
- Once Bash is available to an editing stage, Claude Code also runs commands it judges read-only; this was already a documented risk for configured tool rules.
- In a live comparison on a small repository, the follow-up check's Codex input halved and answers were shorter. The savings grow with the size of the workspace diff and the number of steps. In a live Research run, Codex's source check found three real problems with Claude's first answer, and Claude corrected all three after reopening the papers.

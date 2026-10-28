# ADR-0009: Working through usage limits, queueing messages, and retrying

**Status:** accepted

**Date:** 2026-10-28

## Context

Both agents run on subscriptions with rolling usage limits, and one of them often runs out first. Until now a quota error made the other agent take that one stage, once. Every later stage tried the exhausted agent again, failed, and fell back, and when both were out the run simply failed. The user then had to notice when the limits reset and resume by hand.

Users also wanted to type the next message while one runs, and to go back: when a later message went wrong, run an earlier one again, with its file changes undone.

## Decision

- **Remember limits.** `AgentLimits` records each limit an agent reports, with its reset time read from the provider's message.
  - It handles Unix and ISO times, durations such as "try again in 2 hours 13 minutes", and clock times such as "resets 3pm".
  - Without a reset time it estimates 15, 30, 60, then 120 minutes.
  - Limits are kept in global state, because they belong to the account rather than the workspace.
  - Only classified provider errors are read.
- **Solo mode.** While an agent is limited, its stages go straight to the other agent, marked as standing in.
  - When the limit resets, the agent is tried again.
  - A Claude session continued from an earlier message is given the messages it missed, instead of being told it already has the whole conversation.
  - The run's answer comes from the stage in Claude's role, whoever ran it.
- **Pause and continue.** When every agent that could run a stage is limited, the run stops with `limitReset`.
  - A `ContinuationScheduler` resumes it a minute after the first reset, survives restarts, and retries while another run holds the lock.
  - Resuming normally asks for edit consent again. The automatic continuation skips that only for the same run, in a trusted workspace, with the same isolation, setup, and verification commands that were in force when it stopped. Otherwise the user resumes by hand.
- **Queue.** A message sent while another runs, while a paused run waits, or while both agents are limited joins a queue.
  - The queue is persisted, bounded at 20, and drained in order whenever the run lock is released or the limits reset.
  - Queued edit messages still go through their consent card.
- **Retry and edit.**
  - **Checkpoints.** Each Edit-mode message records a checkpoint of the conversation's worktree: a Git tree written from the worktree's own index, or a note that the message created the worktree.
  - **Rewinding.** Retrying or editing a message removes it and the later messages, and restores the first checkpoint among them with `git read-tree --reset -u`. It discards the worktree instead when that message created it.
  - **Fresh sessions.** The new run starts fresh sessions, because the earlier sessions also saw what was removed.
  - **Confirmation.** Retrying the last message needs no confirmation; rewinding past later messages, or past changes already applied, does.

## Consequences

- Work continues through one agent's limit, and a paused run finishes by itself, at the cost of some checks being done by the agent that gave the answer. The timeline labels those stages, and `dualAgent.fallbackOnQuota` turns solo mode off.
- An unattended continuation can run an edit and its verification commands without a new prompt. This is limited to unchanged commands, and `dualAgent.limits.autoContinue` turns it off.
- Reset times come from provider wording, which can change. Unrecognized wording falls back to estimates, so the cost is extra attempts, not a stuck run.
- A retry costs more tokens than a follow-up, because sessions start fresh.
- Checkpoint trees are unreferenced objects, which `git gc` eventually removes. A retry whose checkpoint is gone stops and says so rather than guessing.

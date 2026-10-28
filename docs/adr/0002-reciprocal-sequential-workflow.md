# ADR-0002: Reciprocal sequential workflow

**Status:** accepted; amended by [ADR-0006](0006-isolation-and-verification-gate.md), which adds a final gate with bounded fix rounds and makes the finalization stage read-only

**Date:** 2026-10-27

## Context

The desired behavior gives Claude greater implementation weight, uses Codex for independent review, asks Claude to adjudicate findings, and requires both systems to challenge the other's output.

## Decision

Use finite sequential workflows with alternating providers. Claude owns planning, implementation, adjudication, and final synthesis. Codex owns independent plan review, code review, and final verification. Brainstorming follows proposal, challenge, synthesis, final challenge, and recommendation.

## Consequences

- No simultaneous working-tree writes occur.
- Full workflows consume more quota than single-agent work.
- Review responsibility and provenance are explicit.
- Endless debate is prevented by fixed stages and one finalization pass.

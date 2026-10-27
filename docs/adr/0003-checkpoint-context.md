# ADR-0003: Checkpoint context instead of transcript mirroring

**Status:** accepted

**Date:** 2026-10-27

## Context

Providers cannot share hidden reasoning, and mirroring complete transcripts increases cost, anchoring, and prompt-injection exposure.

## Decision

Synchronize at stage boundaries using the objective, explicit stage contract, Git evidence, and bounded completed-stage artifacts. Treat every imported artifact as untrusted evidence.

## Consequences

- Handoffs are inspectable and provider-neutral.
- Context use is bounded.
- Some nuance from a provider's private session is intentionally lost.
- Repository state and deterministic checks remain the common source of truth.

# ADR-0001: CLI-first local integration

**Status:** accepted

**Date:** 2026-10-27

## Context

The product must use existing local Claude and Codex subscription sign-ins where supported, avoid owning credentials, and provide structured progress inside VS Code.

## Decision

Use the official local CLIs with structured streaming as the first production integration. Prompts travel through stdin; commands use fixed argument arrays; authentication remains in each CLI. Default subscription mode removes API-key environment variables.

## Consequences

- Installation requires both CLIs.
- Desktop VS Code is required.
- Provider event schema changes require parser maintenance.
- The architecture can later add app-server/SDK adapters without changing workflow policy.

# Agent contribution instructions

Read `README.md`, `PROJECT_STATUS.md`, and the relevant document under `docs/` before changing behavior.

## Required boundaries

- Preserve existing user changes and never reset the working tree.
- Do not read or expose Claude/Codex credential files.
- Keep subscription mode free of API-key environment variables.
- Do not add shell interpolation for prompts, paths, models, or executable settings.
- Keep executable settings machine-scoped.
- Keep Codex review stages read-only and require explicit consent before write stages.
- Keep provider-specific schemas inside `src/adapters/`.
- Update tests, `CHANGELOG.md`, and `PROJECT_STATUS.md` with behavior changes.
- Run `npm.cmd run check` before declaring completion.

## Architecture

Core orchestration must remain testable without VS Code or live model calls. UI code belongs under `src/ui`; provider integration belongs under `src/adapters`; pure workflow policy belongs under `src/core`.

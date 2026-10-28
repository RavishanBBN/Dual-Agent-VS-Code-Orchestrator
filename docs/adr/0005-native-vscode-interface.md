# ADR-0005: Native VS Code interface

**Status:** accepted

**Date:** 2026-10-28

## Context

Releases 1.x presented the extension as a webview dashboard: an HTML page with its own script, styles, form controls, and message protocol. That made the extension look and behave like an embedded web app rather than a VS Code extension, and it carried costs:

- the page duplicated controls VS Code already provides (inputs, buttons, progress, lists) and did not follow themes, keyboard navigation, or accessibility conventions as closely;
- every user action crossed a message boundary that needed its own validation code and Content Security Policy;
- stage outputs and diffs were not shown at all, because rendering agent text in HTML is risky;
- users expected the Command Palette, tree views, the status bar, and the diff editor.

## Decision

Use only native VS Code components:

- an activity-bar container with a **Runs** tree view (runs, stages, checks, warnings, changed files) and an **Agents** tree view, plus a welcome view;
- commands with icons, `view/title` and `view/item/context` menus driven by context values, and Command Palette entries;
- QuickPick and input boxes for the folder, objective, and approval; modal messages for consent;
- a status bar item for progress and approval, and a log output channel for activity;
- read-only virtual documents (`dual-agent-run:`) for reports, stage outputs, and check logs, and the built-in diff and multi-file diff editors (`dual-agent-base:` as the left side) for changes.

Labels, icons, context values, tooltips, and dialog text are produced by pure functions in `src/ui/presentation.ts`, which does not import `vscode`, so they are unit-tested. Agent text in tooltips is Markdown-escaped and placed in untrusted `MarkdownString`s.

## Consequences

- The webview, its assets, its message validation, and its CSP are removed.
- Stage outputs, check logs, and diffs are now visible, through editors that never execute content.
- Long objectives are written in an editor and passed as the selection instead of in a text area.
- View classes and `extension.ts` import `vscode`, so they are verified by an automated smoke test in a real VS Code (`npm run smoke`) rather than by unit coverage.

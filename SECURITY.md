# Security policy

## Supported versions

Security fixes are released for the latest 2.x version on the Visual Studio Marketplace and Open VSX. Update to it before reporting.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

Include:

- the affected version;
- reproducible steps using a disposable repository;
- the expected and actual permission boundary;
- the impact and a suggested mitigation.

Do not include authentication tokens, cookies, API keys, proprietary source code, private prompts, or complete provider credential files.

Fixes are released as a new version, with credit in the changelog unless you prefer otherwise.

## High-priority issues

- command or argument injection;
- workspace-write execution without explicit consent, including an automatic continuation that runs changed commands;
- escape from configured read-only behavior;
- credential or API-key exposure, including credentials the masking should have caught;
- repository-controlled executable replacement;
- execution of agent or repository content in the editor UI (for example through trusted Markdown links, or HTML in the chat page);
- repository hooks or configured commands running without the documented consent;
- silent switching from subscription use to paid API billing;
- run-history leakage outside private extension storage;
- a retry that changes files outside the extension's worktree storage.

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

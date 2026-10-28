# Security policy

## Supported version

Security fixes are applied to the latest 1.x release.

## Reporting

Report vulnerabilities privately to the repository owner. Include:

- affected version;
- reproducible steps using a disposable repository;
- expected and actual permission boundary;
- impact and suggested mitigation.

Do not include authentication tokens, cookies, API keys, proprietary source code, private prompts, or complete provider credential files.

## High-priority issues

- command or argument injection;
- workspace-write execution without explicit consent;
- escape from configured read-only behavior;
- credential or API-key exposure;
- repository-controlled executable replacement;
- execution of agent or repository content in the editor UI (for example through trusted Markdown links);
- repository hooks or configured commands running without the documented consent;
- silent switching from subscription use to paid API billing;
- run-history leakage outside private extension storage.

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

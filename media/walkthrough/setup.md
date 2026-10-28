# Install and sign in

Dual Agent runs the official command-line tools on your machine. It does not ship a model or an API key of its own.

1. Install **Claude Code** and run `claude` once to sign in.
2. Install the **Codex CLI** and run `codex login`.
3. Run **Dual Agent: Check Agent Setup**. Both rows should show a check mark.

By default the extension removes API keys and alternate endpoints from the agents' environment, so they use your saved subscription sign-in. Set `dualAgent.billingMode` to `environment` only if you want API billing.

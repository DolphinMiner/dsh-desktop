# Contributing

Thanks for helping improve DSH Desktop. This repository is intentionally a
bounded desktop integration layer around DeepSeek Harness. Agent behavior, model adapters,
tools, sessions, and the upstream Web UI should normally be changed in the
[DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness).

## Development Setup

Use Node.js 24 and npm 10 or newer. On macOS:

```bash
nvm use
npm ci
npm run check
npm start
```

Build the current Apple Silicon target with:

```bash
npm run package:mac
```

## Pull Requests

Keep changes focused on the desktop lifecycle or a clearly bounded native
integration. Add tests at the observable boundary for startup, failure,
shutdown, navigation, and IPC changes. Run `npm run check` before opening a
pull request.

Do not commit `node_modules`, `dist`, `release`, local Harness data, logs, API
keys, tokens, prompts, workspace content, or screenshots containing private
information.

For a visible change, include sanitized before and after screenshots. For a
new desktop capability, document its permissions and keep the Electron IPC
surface explicit and allowlisted.

Connection integrations must keep long-lived credentials in the platform
credential store. Do not place tokens in Harness configuration, model-visible
results, process arguments, URLs exposed outside loopback, or browser storage.

## Reporting Problems

Use the repository issue forms for reproducible desktop bugs and feature
requests. Follow [SECURITY.md](SECURITY.md) for vulnerabilities. Upstream
Harness behavior should be reported upstream so one source of truth remains
responsible for it.

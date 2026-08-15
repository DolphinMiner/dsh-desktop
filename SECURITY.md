# Security Policy

## Supported Versions

Security fixes are made on `main` and in the latest published release. Older
releases may not receive backports while the project is in early development.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
[Report a vulnerability](https://github.com/DolphinMiner/dsh-desktop/security/advisories/new)
flow and include reproduction steps, impact, and the affected version.

Never include API keys, OAuth tokens, prompts, workspace content, or raw local
Harness data. Sanitize `~/Library/Logs/DSH Desktop/harness.log` before sharing
it. We aim to acknowledge a complete report within five business days.

Issues in the agent loop, model adapters, tools, sessions, or upstream Web UI
should be reported to the
[DeepSeek Harness project](https://github.com/deepseek-ai/deepseek-harness/security).
Desktop process management, navigation, packaging, and Electron IPC belong in
this repository.

Repository maintainers must keep GitHub private vulnerability reporting
enabled so the reporting link remains available.

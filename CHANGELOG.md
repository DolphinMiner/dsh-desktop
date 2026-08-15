# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- macOS Electron host for the bundled DeepSeek Harness Web UI.
- Loopback-only runtime startup, health checking, retry UI, and clean shutdown.
- Local Harness data and log directories under the macOS application paths.
- Tests for output parsing, child-process lifecycle, and desktop IPC origin checks.
- CI, dependency update automation, contribution guidance, and security policy.
- macOS application icon based on the Harness home-page fish mark.
- Electron, Chromium, and LGPL dependency notices in packaged applications.
- Product-owned `desktop` Harness profile composed from official bundle layers.
- Versioned parent/child capability protocol with validation, cancellation,
  timeout handling, duplicate suppression, and disconnect cleanup.
- Native completion and failure notifications from a desktop Cordis host plugin.
- npm workspace packages for desktop protocol, host, agent, client, and bundle
  extension points.
- A Connections settings page contributed through the official Harness client
  slot API, with truthful status, reconnect, and disconnect controls.
- Multiple Linear workspaces through the official remote MCP endpoint, with
  read-only and approved read-write modes.
- Linear OAuth with PKCE, encrypted recovery, token refresh rotation, confirmed
  revocation, cancellation, timeout handling, and cold-start completion.
- A generic stdio and Streamable HTTP MCP supervisor with reconnect status.

### Security

- Sandboxed renderer with Node.js integration disabled.
- Exact source validation for the desktop preload IPC handlers.
- Navigation restricted to the active loopback Harness origin and bundled loading page.
- Connection credentials and OAuth recovery state encrypted with macOS Keychain.
- Bearer credentials attached only by an ephemeral loopback proxy and withheld
  from Harness configuration, tool results, logs, and browser storage.
- Duplicate possible-write MCP calls blocked at the desktop proxy boundary.

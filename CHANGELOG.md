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

### Security

- Sandboxed renderer with Node.js integration disabled.
- Exact source validation for the desktop preload IPC handlers.
- Navigation restricted to the active loopback Harness origin and bundled loading page.

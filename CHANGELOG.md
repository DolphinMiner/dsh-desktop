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
- Native menus, shortcuts, project picker, deep links, session routing, and
  truthful task activity in the window title and Dock.
- Workspace-bound Finder reveal and approved file-open tools contributed through
  the official Harness agent tool registry.
- Atomic window-state restoration and bounded automatic Harness recovery.
- Product-level contracts for official session persistence, workspace routing,
  tool execution, diff presentation, reconnect, and cold-start behavior.
- A versioned read-only Computer Observe lifecycle with explicit display,
  window, or application targeting and deterministic stop/revoke behavior.
- A signed-ready Swift helper using ScreenCaptureKit, Vision OCR, and a bounded
  macOS accessibility tree without exposing generic native APIs to the renderer.
- Read-only `computer_get_permissions`, `computer_list_apps`, and
  `computer_observe` agent tools plus Computer settings for permission state,
  target selection, observation status, refresh, and stop.
- Snapshot-bound Computer Act support for semantic click, type, key, and scroll
  operations, with capture-relative points kept as explicit fallbacks.
- Approved Harness computer-action tools, session-scoped application grants,
  pause/resume/revoke controls, and a recent action audit surface.

### Security

- Sandboxed renderer with Node.js integration disabled.
- Exact source validation for the desktop preload IPC handlers.
- Navigation restricted to the active loopback Harness origin and bundled loading page.
- Connection credentials and OAuth recovery state encrypted with macOS Keychain.
- Bearer credentials attached only by an ephemeral loopback proxy and withheld
  from Harness configuration, tool results, logs, and browser storage.
- Duplicate possible-write MCP calls blocked at the desktop proxy boundary.
- Native file actions reject traversal, symlink escapes, inactive workspaces,
  directories, and executable targets.
- Pending native work is cancelled on Harness disconnect and never replayed by
  automatic recovery.
- Computer captures use private directories and files, bounded retention, and
  explicit cleanup; secure-field regions and values are redacted before OCR or
  model-visible output.
- The native computer helper has bounded input/output, execution time, and
  accessibility-tree depth, with crash, cancellation, stale-target, and
  permission-denial handling.
- Every computer action revalidates the foreground application, surface bounds,
  display topology, and accessibility target before emitting an input event.
- Computer action intent, approval, dispatch, and outcome are persisted without
  typed payloads; dispatched actions with uncertain results are never replayed.
- Secure fields are refused, and type-action results omit OCR and control values
  that could echo the entered text.

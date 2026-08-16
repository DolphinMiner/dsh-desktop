# Desktop Automations Architecture

DSH Desktop automations schedule new, unattended agent runs. They are not a
second implementation of ordinary Harness turns, background jobs, goals, or
workflows. The desktop owns durable trigger and run coordination; the official
DeepSeek Harness remains the authority for every live agent, session, model
turn, tool call, approval, transcript, and generated file.

This boundary targets the pinned Harness `0.1.0-rc.6` contracts.

## Ownership

| Concern | Authority |
| --- | --- |
| Automation definition, enabled state, trigger, time zone, and concurrency policy | Electron Main |
| Immutable run identity, reviewed payload, dispatch phase, terminal projection, and retry lineage | Electron Main |
| Due-time calculation, missed-trigger policy, and overlap admission | Electron Main |
| Repository isolation and managed-worktree lifecycle | Existing desktop worktree services |
| Live agent construction, session persistence, turn execution, tools, approvals, and transcript | Official Harness |
| Live agent handle and mapping of one desktop run to one Harness session | Desktop Host plugin |
| In-session background commands | Official `ctx.jobs` and `dsh-tool-jobs` |
| Same-session long-running objective | Official `ctx.goals` and goal driver |
| Model-written subagent orchestration | Official `ctx.workflowEngine` |
| Session-local reminders | Official `dsh-schedule` |
| Task Center and run-history presentation | Desktop Client plugin projecting the desktop ledger and Harness session |

No automation path may patch the official Harness packages, create a second
agent loop, write synthetic assistant results, or treat a desktop projection as
more authoritative than the Harness session log.

## Official Harness Reuse

### Jobs

`ctx.jobs` is an in-process registry. Its local implementation deliberately
loses records with the Harness process and ties owned work to one live Agent.
An automation agent may use normal background-job tools during its turn, but a
desktop automation run is not a Harness Job and cannot derive restart recovery
or durable history from `ctx.jobs`.

### Goals

`ctx.goals` stores one event-sourced objective inside an existing Session. It
does not decide when work starts, and its continuation authority is deliberately
process-local after restart. An automation may opt into a Goal for multi-round
work after its agent exists; the desktop definition and run lifecycle remain
outside Goal state.

### Workflows

`ctx.workflowEngine` executes one foreground, holder-owned orchestration script.
The current worker-thread engine has no journal or restart resume. Workflow is
available to the automation agent as an ordinary tool, but it is not the
desktop scheduler or durable run coordinator.

### Schedule

`dsh-schedule` persists reminders in one Session log and delivers them only
while that Session is live. It intentionally has no cold-session wakeup and a
documented crash duplicate window around follow-up admission. It remains the
right implementation for conversational reminders. Desktop automations need a
separate app-level timer and ledger because they create dedicated sessions,
must surface missed triggers, and must never redispatch an uncertain run.

## Durable Model

An automation definition contains:

- immutable automation id and monotonic revision;
- name and bounded prompt;
- canonical project and repository identity;
- one-shot UTC target or five-field calendar cadence plus an explicit IANA time
  zone;
- execution mode, defaulting to an isolated managed worktree;
- enabled state and overlap policy;
- optional Skill and Connection references by stable id, never credentials;
- creation, update, last-trigger, and next-trigger timestamps.

Deletion writes a tombstone. Reusing an automation id or revision is invalid.
Editing a definition never rewrites an existing run payload.

Every trigger allocates an immutable run id and snapshots the complete reviewed
execution payload before any dispatch attempt. A run moves through this closed
lifecycle:

```text
queued -> dispatching -> running -> succeeded | failed | cancelled | interrupted | ambiguous
```

`queued` is recoverable work that has not crossed the dispatch boundary.
`dispatching` means Main durably granted one Host claim. A restart never turns
`dispatching` back into `queued`. Only exact Harness session evidence may refine
it to `running` or a terminal state; otherwise it becomes `ambiguous` and needs
an explicit new retry run.

A retry receives a new run id and records the prior run id. It never reuses the
old dispatch identity.

## Dispatch Protocol

1. Main evaluates a trigger while holding the scheduler decision lock.
2. Main applies the overlap policy and persists the full `queued` run payload.
3. Main emits a best-effort `automations.changed` wakeup. Failure leaves the
   queued run durable.
4. The Host plugin lists pending work and claims one exact run through the
   typed protocol-v20 desktop capability bridge. A repeated pull from the same
   live Host identity returns the already-persisted claim instead of preparing
   or dispatching the run again.
5. Main atomically persists `dispatching` before returning the claim. This is
   the no-replay boundary.
6. Host creates one top-level official Agent with the run-bound Session id,
   approved workspace, current default model, selected Skills, and only the
   selected Connection tool prefixes. A managed checkout is bound to that
   exact Session before execution.
7. Main persists `running` from the published Session sequence before Host
   submits one identified automation prompt. Host re-reads its exact owned run
   at this boundary; a cancellation, missing claim, or ambiguous acknowledgement
   submits no prompt.
8. Host waits for the official Agent to become idle, flushes its Session, and
   maps the matching durable `turn/end` reason and sequence back to Main.
   Only an exact terminal report may be retried after an ambiguous response;
   the Agent turn itself is never replayed.
9. Main persists the run projection before publishing Task Center updates or
   notifications.

The parent-to-child event is only a wakeup, never the durable queue and never an
acknowledgement. Host reconnect always begins by listing durable queued work.

Main prepares the approved workspace before granting the Host claim. Local
mode revalidates the exact reviewed project and repository identity. Worktree
mode reuses the existing durable WorktreeManager with an idempotent operation
derived from the run id, then maps a nested project path into that checkout. A
clear or uncertain worktree-preparation failure never grants an Agent claim;
the run records a failed startup while the separate worktree journal retains
any recovery requirement.

## Recovery Rules

- A crash before a durable claim leaves the run `queued` and dispatchable.
- A crash after a durable claim never causes automatic replay.
- App startup and Harness disconnect atomically mark every claimed run lacking
  terminal Session evidence as `ambiguous`; queued runs remain dispatchable.
- A published run-bound Session may refine `dispatching` to `running`.
- A matching terminal `turn/end` may refine the run to `succeeded`, `failed`,
  `cancelled`, or `interrupted` according to the exact Harness reason.
- Missing, conflicting, or unverifiable post-claim evidence produces
  `ambiguous`, not success and not a fresh dispatch.
- A terminal run is immutable except for bounded presentation metadata that
  does not alter outcome.
- Notifications project the persisted terminal state. They never serve as the
  terminal commit.
- Cancelling a queued run is local and terminal. Cancelling a claimed or
  running run is persisted first. The change event only wakes a Host read of
  the owned run; a matching request calls `cancel({ kind: 'user' })` on that
  exact official Agent and records only the resulting durable turn outcome.

The run outcome describes the Agent lifecycle only. It does not imply that an
external provider write succeeded; each tool keeps its own approval, timeout,
idempotency, ambiguity, and audit contract.

## Scheduling Policy

The first release runs only while DSH Desktop is open and states that limitation
in the UI. It does not install a daemon or claim wake-from-sleep delivery.

- One-shot targets are stored as canonical UTC instants.
- Recurring rules use a five-field calendar expression and an explicit IANA
  time zone.
- A nonexistent daylight-saving local time is skipped.
- A repeated daylight-saving local time runs once at its earlier occurrence.
- On startup, a recurring automation admits only the latest missed occurrence;
  it never replays an unbounded backlog.
- Calendar evaluation uses a pinned, timezone-aware cron parser. Randomized
  `H` expressions are rejected so every process derives the same occurrence.
- Duplicate timer delivery for the same occurrence resolves to one immutable
  run id.
- Overlap is disabled by default. A configured queue policy admits at most one
  deferred occurrence while the current run remains nonterminal.

Trigger admission, cadence advancement, and optional run creation share one
atomic registry commit. A persistence failure advances neither the definition
nor the run queue. The scheduler stops on an authority error and is recreated
on the next application launch; a renderer event or Host wakeup is never used
as proof that a trigger was admitted.

## Task Center

The desktop client contributes Task Center through official Harness settings
and sidebar slots. Electron preload exposes only typed automation methods; the
renderer cannot read the registry file, invoke Git directly, or choose a
repository identity.

- Creation supports one-shot or zoned five-field recurring schedules,
  worktree or explicitly acknowledged local execution, overlap policy, and
  connected-provider selection.
- Main canonicalizes the selected project, rediscovers its exact Git identity,
  computes the next occurrence from a request-stable schedule anchor, and only
  then persists the definition.
- Pause, resume, delete, manual run, retry, cancel, and open-session controls
  use operation ids and optimistic definition revisions.
- Task Center renders a bounded recent-run page and can load older pages against
  an exact registry revision, while Main retains the complete durable run
  ledger. Each row exposes the immutable invocation, prepared workspace,
  lifecycle log, bounded result, cancellation state, and its official Harness
  Session when one was started.
- Native notifications are emitted only for a newly persisted terminal run.
  Duplicate terminal acknowledgements do not notify twice. Notification text
  describes the Agent lifecycle and tells the user to review uncertain or
  external effects instead of claiming those effects succeeded.

The first release requires DSH Desktop to remain open. Closing the app stops
the local scheduler; the next launch applies the documented missed-run policy.

## Security And Presentation

- Renderer input is parsed by the versioned desktop protocol and never gains a
  generic Electron or Node bridge.
- Connection references resolve inside the existing credential boundary;
  prompts and run records never contain access tokens.
- Local checkout execution requires an explicit warning. Managed worktrees are
  the default for repository automations.
- Task Center reads the desktop ledger for scheduling state and opens the
  official Harness Session for transcript and tool history.
- Delete, retry, cancel, local-checkout execution, and any external write retain
  explicit approval and audit behavior appropriate to their effects.

## Initial Delivery Slices

1. Strict automation and run protocol plus a durable registry with immutable
   run payloads and tombstones.
2. Deterministic trigger calculation and scheduler decisions without dispatch.
3. Host pull/claim bridge and one run-bound official Agent Session.
4. Managed-worktree-by-default execution and exact restart reconciliation.
5. Task Center controls, run history, notifications, cancellation, and explicit
   retry as a new run.

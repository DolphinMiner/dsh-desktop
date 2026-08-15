import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DESKTOP_PROTOCOL_VERSION } from '@dolphinminer/dsh-desktop-protocol'

import { DesktopCapabilityBroker } from './desktop-capability-broker'
import { createDesktopCapabilityHandlers } from './desktop-capabilities'
import { HarnessRecoveryController } from './harness-recovery'
import { HarnessService } from './harness-service'
import { HarnessPhase, HarnessState } from './types'

const FIXTURE_PATH = join(process.cwd(), 'test', 'fixtures', 'fake-harness.mjs')
const unconfiguredGit = {
  discover: () => Promise.reject(new Error('not configured')),
  status: () => Promise.reject(new Error('not configured')),
}
const unconfiguredWorktrees = {
  snapshot: () => ({ revision: 0, worktrees: [] }),
  provision: () => Promise.reject(new Error('not configured')),
  reportSessionBinding: () => Promise.resolve({ managed: false }),
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface StateObserver {
  states: HarnessState[]
  onState(state: HarnessState): void
  reached: Promise<HarnessState>
}

function observePhase(phase: HarnessPhase, timeoutMs = 5_000): StateObserver {
  const states: HarnessState[] = []
  let resolveReached: (state: HarnessState) => void
  let rejectReached: (error: Error) => void
  const reached = new Promise<HarnessState>((resolve, reject) => {
    resolveReached = resolve
    rejectReached = reject
  })
  const timer = setTimeout(
    () => rejectReached(new Error(`Timed out waiting for Harness phase ${phase}`)),
    timeoutMs,
  )

  return {
    states,
    reached,
    onState(state) {
      states.push(state)
      if (state.phase !== phase) return
      clearTimeout(timer)
      resolveReached(state)
    },
  }
}

async function withService(
  mode: string,
  observer: StateObserver,
  run: (service: HarnessService, root: string) => Promise<void>,
  startupTimeoutMs = 2_000,
  nodeExecutable = process.execPath,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-test-'))
  const service = new HarnessService({
    dshBin: FIXTURE_PATH,
    dshHome: join(root, 'home'),
    cwd: root,
    logPath: join(root, 'logs', 'harness.log'),
    nodeExecutable,
    env: { DSH_TEST_MODE: mode },
    startupTimeoutMs,
    onState: state => observer.onState(state),
  })

  try {
    await run(service, root)
  } finally {
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
}

test('starts a healthy Harness and stops it cleanly', async () => {
  const observer = observePhase('ready')

  await withService('ready', observer, async (service, root) => {
    await service.start()
    const ready = await observer.reached

    assert.equal(ready.phase, 'ready')
    assert.match(ready.url ?? '', /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.deepEqual(observer.states.map(state => state.phase), ['starting', 'ready'])

    await service.stop()
    const log = await readFile(join(root, 'logs', 'harness.log'), 'utf8')
    assert.match(log, /Harness ready at http:\/\/127\.0\.0\.1:/)
    assert.match(log, /stopping Harness/)
  })
})

test('launches the explicit desktop profile instead of the web alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-argv-test-'))
  const argvPath = join(root, 'argv.json')
  const service = new HarnessService({
    dshBin: FIXTURE_PATH,
    dshHome: join(root, 'home'),
    cwd: root,
    logPath: join(root, 'logs', 'harness.log'),
    nodeExecutable: process.execPath,
    env: { DSH_TEST_MODE: 'ready', DSH_TEST_ARGV_PATH: argvPath },
    onState: () => undefined,
  })
  try {
    await service.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    const argv = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
    assert.deepEqual(argv.slice(0, 2), ['--profile', 'desktop'])
    assert.equal(argv.includes('web'), false)
  } finally {
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('routes a child-process capability request through the desktop broker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-ipc-test-'))
  let resolvePing: (nonce: string) => void
  const ping = new Promise<string>(resolve => {
    resolvePing = resolve
  })
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: { report: () => true },
    workspaceFiles: {
      reveal: () => Promise.reject(new Error('not configured')),
      open: () => Promise.reject(new Error('not configured')),
    },
    git: unconfiguredGit,
    worktrees: unconfiguredWorktrees,
    connections: {
      snapshot: () => ({
        revision: 0,
        vault: { available: true },
        oauth: { linear: { available: false } },
        connections: [],
      }),
      resolveMcpTransport: () => Promise.reject(new Error('not configured')),
      reportStatus: () => ({ accepted: false, revision: 0 }),
    },
  })
  handlers['desktop.ping'] = params => {
    resolvePing(params.nonce)
    return { nonce: params.nonce, protocolVersion: DESKTOP_PROTOCOL_VERSION }
  }
  const service = new HarnessService({
    dshBin: FIXTURE_PATH,
    dshHome: join(root, 'home'),
    cwd: root,
    logPath: join(root, 'logs', 'harness.log'),
    nodeExecutable: process.execPath,
    env: { DSH_TEST_MODE: 'capability' },
    capabilityBroker: new DesktopCapabilityBroker(handlers),
    onState: () => undefined,
  })
  try {
    await service.start()
    assert.equal(await withTimeout(ping, 'fixture capability request'), 'from-child')
  } finally {
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('restarts the same Harness service without leaking the previous run', async () => {
  const firstReady = observePhase('ready')

  await withService('ready', firstReady, async service => {
    await service.start()
    await firstReady.reached

    const secondReady = observePhase('ready')
    firstReady.onState = state => {
      firstReady.states.push(state)
      secondReady.onState(state)
    }

    await service.start()
    await secondReady.reached

    assert.deepEqual(firstReady.states.map(state => state.phase), [
      'starting',
      'ready',
      'starting',
      'ready',
    ])
  })
})

test('reports a child process that exits before readiness', async () => {
  const observer = observePhase('error')

  await withService('exit', observer, async (service, root) => {
    await service.start()
    const failed = await observer.reached

    assert.match(failed.message, /exit code 7/)
    assert.deepEqual(observer.states.map(state => state.phase), ['starting', 'error'])

    await service.stop()
    const log = await readFile(join(root, 'logs', 'harness.log'), 'utf8')
    assert.match(log, /Harness stopped unexpectedly \(exit code 7\)/)
  })
})

test('reports and cleans up a child process that cannot be spawned', async () => {
  const observer = observePhase('error')

  await withService(
    'ready',
    observer,
    async service => {
      await service.start()
      const failed = await observer.reached

      assert.match(failed.message, /Harness could not start/)
      await service.stop()
    },
    2_000,
    '/definitely/missing/dsh-desktop-node',
  )
})

test('rejects an announced URL whose server is not healthy', async () => {
  const observer = observePhase('error')

  await withService('unhealthy', observer, async service => {
    await service.start()
    const failed = await observer.reached

    assert.match(failed.message, /announced a URL but did not become healthy/)
  })
})

test('times out a Harness that never announces readiness', async () => {
  const observer = observePhase('error')

  await withService(
    'silent',
    observer,
    async service => {
      await service.start()
      const failed = await observer.reached

      assert.match(failed.message, /did not become ready within 50 milliseconds/)
    },
    50,
  )
})

test('cancels pending desktop work and recovers without replay after a Harness crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-recovery-test-'))
  const observer = observePhase('ready')
  let openCalls = 0
  let resolveCancelled: () => void
  const cancelled = new Promise<void>(resolve => { resolveCancelled = resolve })
  const handlers = createDesktopCapabilityHandlers({
    isAppFocused: () => false,
    notifications: { isSupported: () => false, show: () => undefined },
    sessionActivity: { report: () => true },
    workspaceFiles: {
      reveal: () => Promise.reject(new Error('not configured')),
      open: (_params, signal) => {
        openCalls += 1
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            resolveCancelled()
            const error = new Error('cancelled')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    },
    git: unconfiguredGit,
    worktrees: unconfiguredWorktrees,
    connections: {
      snapshot: () => ({
        revision: 0,
        vault: { available: true },
        oauth: { linear: { available: false } },
        connections: [],
      }),
      resolveMcpTransport: () => Promise.reject(new Error('not configured')),
      reportStatus: () => ({ accepted: false, revision: 0 }),
    },
  })
  let recovery: HarnessRecoveryController
  const service = new HarnessService({
    dshBin: FIXTURE_PATH,
    dshHome: join(root, 'home'),
    cwd: root,
    logPath: join(root, 'logs', 'harness.log'),
    nodeExecutable: process.execPath,
    env: {
      DSH_TEST_MODE: 'capability-exit-once',
      DSH_TEST_RECOVERY_MARKER: join(root, 'failed-once'),
    },
    capabilityBroker: new DesktopCapabilityBroker(handlers),
    onUnexpectedFailure: () => recovery.handleUnexpectedFailure(),
    onState: state => observer.onState(state),
  })
  recovery = new HarnessRecoveryController({
    start: () => service.start(),
    onSchedule: () => undefined,
    onExhausted: () => assert.fail('recovery should not be exhausted'),
    delaysMs: [5],
  })

  try {
    await recovery.restartNow()
    await Promise.all([observer.reached, withTimeout(cancelled, 'capability cancellation')])
    await new Promise(resolve => setTimeout(resolve, 30))

    assert.equal(openCalls, 1)
    assert.deepEqual(observer.states.map(item => item.phase), ['starting', 'error', 'starting', 'ready'])
  } finally {
    recovery.stop()
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

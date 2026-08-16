import { createServer } from 'node:http'

import { DESKTOP_PROTOCOL_VERSION } from '@dolphinminer/dsh-desktop-protocol'

let mode = process.env.DSH_TEST_MODE

if (mode === 'recover-once' || mode === 'capability-exit-once') {
  const { existsSync, writeFileSync } = await import('node:fs')
  const markerPath = process.env.DSH_TEST_RECOVERY_MARKER
  if (!markerPath) process.exit(4)
  if (existsSync(markerPath)) {
    mode = 'ready'
  } else {
    writeFileSync(markerPath, 'failed once\n')
    mode = mode === 'recover-once' ? 'exit' : 'capability-exit'
  }
}

if (process.env.DSH_TEST_ARGV_PATH) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.DSH_TEST_ARGV_PATH, `${JSON.stringify(process.argv.slice(2))}\n`)
}

function stayAlive() {
  const timer = setInterval(() => undefined, 1_000)
  process.on('SIGTERM', () => {
    clearInterval(timer)
    process.exit(0)
  })
}

if (mode === 'ready' || mode === 'capability' || mode === 'capability-binary') {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
  })

  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') process.exit(2)
    process.stdout.write(`booting\ndsh web: http://127.0.0.1:${address.port}\n`)
    if (mode === 'capability') {
      if (typeof process.send !== 'function') process.exit(3)
      process.send({
        channel: 'dsh-desktop',
        version: DESKTOP_PROTOCOL_VERSION,
        kind: 'request',
        id: 'fixture-ping',
        method: 'desktop.ping',
        params: { nonce: 'from-child' },
      })
    } else if (mode === 'capability-binary') {
      if (typeof process.send !== 'function') process.exit(3)
      process.send({
        channel: 'dsh-desktop',
        version: DESKTOP_PROTOCOL_VERSION,
        kind: 'request',
        id: 'fixture-browser-image',
        method: 'browser.screenshot',
        params: { sessionId: 'fixture-session', snapshotId: 'fixture-snapshot' },
      })
    }
  })

  if (mode === 'capability-binary') {
    process.on('message', message => {
      if (message?.id !== 'fixture-browser-image') return
      if (message.kind !== 'response' || message.ok !== true ||
        !(message.result?.data instanceof Uint8Array) || message.result.data[1] !== 2) process.exit(5)
      process.send?.({
        channel: 'dsh-desktop',
        version: DESKTOP_PROTOCOL_VERSION,
        kind: 'request',
        id: 'fixture-binary-ping',
        method: 'desktop.ping',
        params: { nonce: 'binary-ok' },
      })
    })
  }

  process.on('SIGTERM', () => server.close(() => process.exit(0)))
} else if (mode === 'unhealthy') {
  process.stdout.write('dsh web: http://127.0.0.1:9\n')
  stayAlive()
} else if (mode === 'exit') {
  setTimeout(() => process.exit(7), 20)
} else if (mode === 'capability-exit') {
  if (typeof process.send !== 'function') process.exit(3)
  process.send({
    channel: 'dsh-desktop',
    version: DESKTOP_PROTOCOL_VERSION,
    kind: 'request',
    id: 'fixture-open',
    method: 'desktop.openPath',
    params: { sessionId: 'fixture-session', workspaceRoot: '/fixture', path: 'README.md' },
  })
  setTimeout(() => process.exit(8), 30)
} else if (mode === 'silent') {
  stayAlive()
} else {
  process.stderr.write(`unknown fake Harness mode: ${String(mode)}\n`)
  process.exit(2)
}

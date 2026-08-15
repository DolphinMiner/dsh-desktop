import { writeFile } from 'node:fs/promises'

let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
const response = result => process.stdout.write(JSON.stringify({
  version: 2,
  id: request.id,
  ok: true,
  result,
}))

if (process.env.DSH_COMPUTER_FIXTURE_MODE === 'hang') {
  setInterval(() => undefined, 1_000)
} else if (process.env.DSH_COMPUTER_FIXTURE_MODE === 'overflow') {
  process.stdout.write('x'.repeat(8_192))
} else if (request.method === 'permissions') {
  response({
    supported: true,
    screenRecording: 'granted',
    accessibility: 'denied',
    canObserve: true,
    canAct: false,
  })
} else if (request.method === 'listTargets') {
  response({
    permissions: {
      supported: true,
      screenRecording: 'granted',
      accessibility: 'denied',
      canObserve: true,
      canAct: false,
    },
    targets: [{
      id: 'application:42',
      kind: 'application',
      name: 'Editor',
      bundleId: 'dev.editor',
      pid: 42,
      frontmost: true,
    }],
  })
} else if (request.method === 'observe') {
  await writeFile(request.screenshotPath, Buffer.from('png'))
  response({
    version: 2,
    snapshotId: request.snapshotId,
    observedAt: '2026-08-16T12:00:00.000Z',
    target: request.target,
    compatibility: {
      surfaceId: 'window:7:42',
      surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
      displayTopology: [{
        id: 'display:1',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        displayScale: 2,
      }],
    },
    capture: {
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      displayScale: 2,
      pixelWidth: 1600,
      pixelHeight: 1200,
      screenshotCaptured: true,
      ocrText: 'Editor',
    },
    elements: [],
    truncated: false,
    warnings: ['Accessibility permission is not granted.'],
  })
} else {
  process.stdout.write(JSON.stringify({
    version: 2,
    id: request.id,
    ok: false,
    error: { code: 'METHOD_NOT_FOUND', message: 'Unsupported fixture method.' },
  }))
}

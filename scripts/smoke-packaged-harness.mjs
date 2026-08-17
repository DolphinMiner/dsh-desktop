#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appBundle = process.env.DSH_DESKTOP_APP ??
  join(projectRoot, 'release', 'mac-arm64', 'DSH Desktop.app')
const appRoot = join(appBundle, 'Contents', 'Resources', 'app')
const executable = join(appBundle, 'Contents', 'MacOS', 'DSH Desktop')
const dshBin = join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function assertExists(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`)
}

assertExists(executable, 'Packaged desktop executable')
assertExists(dshBin, 'Packaged Harness executable')

const product = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
for (const packageName of Object.keys(product.dependencies ?? {})) {
  assertExists(
    join(appRoot, 'node_modules', ...packageName.split('/'), 'package.json'),
    `Packaged production dependency ${packageName}`,
  )
}

const require = createRequire(import.meta.url)
const { bootstrapDesktopProfile } = require(join(appRoot, 'dist', 'profile-bootstrap.js'))
const { parseHarnessUrl } = require(join(appRoot, 'dist', 'harness-output.js'))
const protocol = await import(pathToFileURL(join(
  appRoot,
  'node_modules',
  '@dolphinminer',
  'dsh-desktop-protocol',
  'lib',
  'index.js',
)).href)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-package-smoke-'))
const dshHome = join(temporaryRoot, 'harness')
let child

function waitForHarness(process) {
  return new Promise((resolveReady, rejectReady) => {
    let stdoutBuffer = ''
    let stderrTail = ''
    let settled = false

    const settle = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error !== undefined) rejectReady(error)
      else resolveReady(url)
    }

    const timeout = setTimeout(() => {
      settle(new Error(`Packaged Harness did not announce readiness.\n${stderrTail}`))
    }, 60_000)

    process.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const url = parseHarnessUrl(line)
        if (url !== undefined) settle(undefined, url)
      }
    })
    process.stderr.on('data', chunk => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-8_000)
    })
    process.once('error', error => settle(error))
    process.once('exit', (code, signal) => {
      const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      settle(new Error(`Packaged Harness stopped before readiness (${detail}).\n${stderrTail}`))
    })
  })
}

async function waitForHealthy(url) {
  const deadline = Date.now() + 5_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = new Error(`HTTP ${String(response.status)}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Packaged Harness was not healthy at ${url}: ${detail}`)
}

async function stopChild(process) {
  if (process.exitCode !== null || process.signalCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveExit => process.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
  ])
  if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
}

function attachDesktopStub(process) {
  process.on('message', value => {
    const request = protocol.parseDesktopProtocolMessage(value)
    if (request?.kind !== 'request' || !process.connected) return

    let result
    if (request.method === 'desktop.ping') {
      result = {
        nonce: request.params.nonce,
        protocolVersion: protocol.DESKTOP_PROTOCOL_VERSION,
      }
    } else if (request.method === 'worktrees.list') {
      result = { revision: 0, worktrees: [] }
    } else if (request.method === 'plugins.getPolicy') {
      result = { revision: 0, overrides: {} }
    } else if (request.method === 'connections.list') {
      result = {
        revision: 0,
        vault: { available: false },
        oauth: { linear: { available: false } },
        connections: [],
      }
    } else if (request.method === 'automations.claimNext' ||
      request.method === 'automations.inspectOwned') {
      result = {}
    } else {
      process.send(protocol.createFailureResponse(request.id, {
        code: 'METHOD_NOT_FOUND',
        message: `Packaged Harness smoke test does not implement ${request.method}.`,
      }))
      return
    }
    process.send(protocol.createSuccessResponse(request.id, result))
  })
}

try {
  bootstrapDesktopProfile({
    dshHome,
    packageRoot: appRoot,
    productVersion: String(product.version),
  })
  child = spawn(executable, [
    '--expose-internals',
    dshBin,
    '--profile',
    'desktop',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      ELECTRON_RUN_AS_NODE: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  attachDesktopStub(child)
  const url = await waitForHarness(child)
  await waitForHealthy(url)
  console.log(`Packaged Harness smoke test passed at ${url}`)
} finally {
  if (child !== undefined) await stopChild(child)
  rmSync(temporaryRoot, { recursive: true, force: true })
}

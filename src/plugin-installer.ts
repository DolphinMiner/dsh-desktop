import { ChildProcess, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type {
  DesktopPluginInstallResult,
  InstallDesktopPluginInput,
} from '@dolphinminer/dsh-desktop-protocol'

import { DESKTOP_MANAGED_BUNDLES, DESKTOP_PACKAGES } from './profile-bootstrap'

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const MAX_CAPTURED_OUTPUT_BYTES = 32 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const PACKAGE_PART = '[a-z0-9][a-z0-9._~-]*'
const PACKAGE_VERSION = '[a-zA-Z0-9][a-zA-Z0-9._+-]*'
const REGISTRY_PLUGIN_SPEC = new RegExp(
  `^(?:@${PACKAGE_PART}/${PACKAGE_PART}|${PACKAGE_PART})(?:@${PACKAGE_VERSION})?$`,
)
const IMMUTABLE_PACKAGES = new Set<string>([
  ...DESKTOP_MANAGED_BUNDLES,
  ...Object.keys(DESKTOP_PACKAGES),
])

interface ProfileManifest {
  dependencies?: Record<string, unknown>
  dsh?: {
    profile?: {
      bundles?: unknown
    }
  }
}

interface PackageManifest {
  name?: unknown
  dsh?: {
    bundle?: {
      patch?: unknown
    }
  }
}

export interface PluginInstallCommandResult {
  exitCode: number
  stderr: string
}

export interface PluginInstallCommandRunner {
  run(args: readonly string[]): Promise<PluginInstallCommandResult>
  dispose(): Promise<void>
}

interface DshPluginCommandRunnerOptions {
  dshBin: string
  dshHome: string
  nodeExecutable: string
  pnpmBin: string
  shimDir: string
  profileName?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

interface DshPluginInstallerOptions {
  profileDir: string
  runner: PluginInstallCommandRunner
  restoreProfile: () => void | Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function packageNameFromSpec(spec: string): string | undefined {
  if (!REGISTRY_PLUGIN_SPEC.test(spec)) return undefined
  if (!spec.startsWith('@')) return spec.split('@', 1)[0]
  const slash = spec.indexOf('/')
  const version = spec.indexOf('@', slash)
  return version === -1 ? spec : spec.slice(0, version)
}

export function parseRegistryPluginSpec(spec: string): { packageName: string; packageSpec: string } | undefined {
  if (spec.length === 0 || spec.length > 512 || spec.trim() !== spec) return undefined
  const packageName = packageNameFromSpec(spec)
  if (packageName === undefined || IMMUTABLE_PACKAGES.has(packageName)) return undefined
  return { packageName, packageSpec: spec }
}

async function readJson(path: string): Promise<unknown> {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error('The plugin manifest is invalid.')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function readProfile(path: string): Promise<ProfileManifest> {
  const value = await readJson(path)
  if (!isRecord(value)) throw new Error('The desktop plugin profile is invalid.')
  return value as ProfileManifest
}

function profileBundles(manifest: ProfileManifest): readonly string[] {
  const bundles = manifest.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((value): value is string => typeof value === 'string') : []
}

function isInstalled(manifest: ProfileManifest, packageName: string): boolean {
  return Object.hasOwn(manifest.dependencies ?? {}, packageName) && profileBundles(manifest).includes(packageName)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= MAX_CAPTURED_OUTPUT_BYTES) return chunk.subarray(chunk.length - MAX_CAPTURED_OUTPUT_BYTES)
  const combined = Buffer.concat([current, chunk])
  return combined.length <= MAX_CAPTURED_OUTPUT_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_CAPTURED_OUTPUT_BYTES)
}

export class DshPluginCommandRunner implements PluginInstallCommandRunner {
  private active?: ChildProcess
  private activeExit?: Promise<void>
  private disposed = false
  private readonly profileName: string
  private readonly timeoutMs: number

  constructor(private readonly options: DshPluginCommandRunnerOptions) {
    this.profileName = options.profileName ?? 'desktop'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async run(args: readonly string[]): Promise<PluginInstallCommandResult> {
    if (this.disposed) throw new Error('Plugin installation has stopped.')
    if (this.active !== undefined) throw new Error('Another plugin operation is already running.')
    await this.preparePnpmShim()
    if (this.disposed) throw new Error('Plugin installation has stopped.')

    return new Promise<PluginInstallCommandResult>((resolveResult, rejectResult) => {
      let settled = false
      let timedOut = false
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let forceTimer: NodeJS.Timeout | undefined
      const child = spawn(this.options.nodeExecutable, [
        this.options.dshBin,
        'plugin',
        '--profile',
        this.profileName,
        ...args,
      ], {
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          ...this.options.env,
          DSH_HOME: this.options.dshHome,
          ELECTRON_RUN_AS_NODE: '1',
          FORCE_COLOR: '0',
          PATH: `${this.options.shimDir}:${this.options.env?.PATH ?? process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.active = child

      let releaseExit: (() => void) | undefined
      this.activeExit = new Promise<void>(resolveExit => { releaseExit = resolveExit })
      const finish = (error?: Error, result?: PluginInstallCommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        if (this.active === child) this.active = undefined
        releaseExit?.()
        this.activeExit = undefined
        if (error !== undefined) rejectResult(error)
        else resolveResult(result!)
      }
      const terminate = (signal: NodeJS.Signals): void => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {
          child.kill(signal)
        }
      }
      const timeout = setTimeout(() => {
        timedOut = true
        terminate('SIGTERM')
        forceTimer = setTimeout(() => terminate('SIGKILL'), 2_000)
        forceTimer.unref()
      }, this.timeoutMs)

      child.stdout?.on('data', () => undefined)
      child.stderr?.on('data', (chunk: Buffer) => { stderr = appendTail(stderr, chunk) })
      child.once('error', error => finish(new Error(`The official DSH plugin command could not start: ${error.message}`)))
      child.once('close', code => {
        if (timedOut) {
          finish(new Error('Plugin installation timed out.'))
          return
        }
        finish(undefined, {
          exitCode: code ?? 1,
          stderr: stderr.toString('utf8'),
        })
      })
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.active
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, 2_000).unref()
    }
    await this.activeExit
  }

  private async preparePnpmShim(): Promise<void> {
    const pnpmInfo = await stat(this.options.pnpmBin).catch(() => undefined)
    if (pnpmInfo?.isFile() !== true) throw new Error('The bundled plugin package manager is unavailable.')
    await mkdir(this.options.shimDir, { recursive: true, mode: 0o700 })
    const shim = join(this.options.shimDir, 'pnpm')
    const temporary = `${shim}.${String(process.pid)}.tmp`
    const source = '#!/bin/sh\n' +
      `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(resolve(this.options.nodeExecutable))} ` +
      `${shellQuote(resolve(this.options.pnpmBin))} "$@"\n`
    try {
      await writeFile(temporary, source, { encoding: 'utf8', mode: 0o700 })
      await rename(temporary, shim)
      await chmod(shim, 0o700)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}

export class DshPluginInstaller {
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly options: DshPluginInstallerOptions) {}

  installRegistry(input: InstallDesktopPluginInput): Promise<DesktopPluginInstallResult> {
    const parsed = parseRegistryPluginSpec(input.packageSpec)
    if (parsed === undefined) {
      return Promise.reject(new Error('Enter an npm package name with an optional version or tag.'))
    }
    return this.exclusive(() => this.install(parsed.packageName, parsed.packageSpec))
  }

  installDirectory(directory: string): Promise<DesktopPluginInstallResult> {
    return this.exclusive(async () => {
      const path = await realpath(directory)
      const info = await stat(path)
      if (!info.isDirectory() || path === resolve(this.options.profileDir)) {
        throw new Error('Select a plugin package directory.')
      }
      const value = await readJson(join(path, 'package.json'))
      if (!isRecord(value)) throw new Error('The selected plugin package manifest is invalid.')
      const manifest = value as PackageManifest
      if (typeof manifest.name !== 'string' || parseRegistryPluginSpec(manifest.name) === undefined) {
        throw new Error('The selected directory has an invalid or reserved package name.')
      }
      if (!isRecord(manifest.dsh) || !isRecord(manifest.dsh.bundle) || manifest.dsh.bundle.patch === undefined) {
        throw new Error('The selected package does not declare a DeepSeek Harness bundle.')
      }
      return this.install(manifest.name, `link:${path}`)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.options.runner.dispose()
    await this.queue
  }

  whenIdle(): Promise<void> {
    return this.queue
  }

  private async install(packageName: string, packageSpec: string): Promise<DesktopPluginInstallResult> {
    const manifestPath = join(this.options.profileDir, 'package.json')
    const before = await readProfile(manifestPath)
    if (isInstalled(before, packageName)) return { packageName, changed: false }

    let result: PluginInstallCommandResult
    try {
      result = await this.options.runner.run(['add', packageSpec, '--save-exact', '--reporter=append-only'])
    } finally {
      await this.options.restoreProfile()
    }
    if (result.exitCode !== 0) throw new Error('The official DSH plugin installer failed.')

    const after = await readProfile(manifestPath)
    if (!isInstalled(after, packageName)) {
      let cleanup: PluginInstallCommandResult
      try {
        cleanup = await this.options.runner.run(['remove', packageName, '--reporter=append-only'])
      } finally {
        await this.options.restoreProfile()
      }
      if (cleanup.exitCode !== 0) {
        throw new Error('The package is not a DSH bundle and could not be removed automatically.')
      }
      throw new Error('The package does not declare a DeepSeek Harness bundle.')
    }
    return { packageName, changed: true }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Plugin installation has stopped.'))
    const result = this.queue.then(() => {
      if (this.disposed) throw new Error('Plugin installation has stopped.')
      return operation()
    })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

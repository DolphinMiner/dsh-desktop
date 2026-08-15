import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const DESKTOP_PROFILE_NAME = 'desktop'
export const DESKTOP_PROFILE_SCHEMA_VERSION = 1

export const DESKTOP_MANAGED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dolphinminer/dsh-desktop-bundle',
] as const

export const DESKTOP_PACKAGES = {
  '@dolphinminer/dsh-desktop-protocol': 'desktop-protocol',
  '@dolphinminer/dsh-desktop-host': 'desktop-host',
  '@dolphinminer/dsh-desktop-agent': 'desktop-agent',
  '@dolphinminer/dsh-desktop-client': 'desktop-client',
  '@dolphinminer/dsh-desktop-bundle': 'desktop-bundle',
} as const

interface DesktopProfileMetadata {
  schemaVersion?: number
  productVersion?: string
  managedBundles?: string[]
  [key: string]: unknown
}

interface ProfileManifest {
  name?: string
  private?: boolean
  version?: string
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  dshDesktop?: DesktopProfileMetadata
  [key: string]: unknown
}

export interface BootstrapDesktopProfileOptions {
  dshHome: string
  packageRoot: string
  productVersion: string
}

export interface DesktopProfilePaths {
  profileDir: string
  manifestPath: string
  patchPath: string
}

function readManifest(path: string): ProfileManifest {
  if (!existsSync(path)) return {}
  const source = readFileSync(path, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`The desktop Harness profile manifest is invalid JSON: ${detail}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The desktop Harness profile manifest must contain a JSON object.')
  }
  return value as ProfileManifest
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, path)
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    throw error
  }
}

function assertPackage(target: string, packageName: string): void {
  const manifestPath = join(target, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`The bundled desktop package is missing: ${manifestPath}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
  if (manifest.name !== packageName) {
    throw new Error(`Expected ${packageName} at ${target}, found ${String(manifest.name)}.`)
  }
}

function resolveDesktopPackageTarget(
  packageRoot: string,
  packageName: string,
  relativeDir: string,
): string {
  const installed = join(packageRoot, 'node_modules', ...packageName.split('/'))
  if (existsSync(join(installed, 'package.json'))) return installed
  return join(packageRoot, 'packages', relativeDir)
}

function ensurePackageLink(profileDir: string, packageName: string, target: string): void {
  assertPackage(target, packageName)
  const linkPath = join(profileDir, 'node_modules', ...packageName.split('/'))
  mkdirSync(dirname(linkPath), { recursive: true })

  if (existsSync(linkPath) || (() => {
    try {
      lstatSync(linkPath)
      return true
    } catch {
      return false
    }
  })()) {
    const stats = lstatSync(linkPath)
    if (!stats.isSymbolicLink()) {
      throw new Error(`DSH Desktop will not replace the existing non-link package at ${linkPath}.`)
    }
    const current = resolve(dirname(linkPath), readlinkSync(linkPath))
    if (current === resolve(target)) return
    unlinkSync(linkPath)
  }

  symlinkSync(resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

export function bootstrapDesktopProfile(
  options: BootstrapDesktopProfileOptions,
): DesktopProfilePaths {
  const profileDir = join(options.dshHome, 'profiles', DESKTOP_PROFILE_NAME)
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(profileDir, { recursive: true })

  const manifest = readManifest(manifestPath)
  const previousManaged = new Set([
    ...DESKTOP_MANAGED_BUNDLES,
    ...stringArray(manifest.dshDesktop?.managedBundles),
  ])
  const customBundles = stringArray(manifest.dsh?.profile?.bundles)
    .filter(bundle => !previousManaged.has(bundle))
  const nextManifest: ProfileManifest = {
    ...manifest,
    name: manifest.name ?? '@dolphinminer/dsh-desktop-profile',
    private: true,
    version: manifest.version ?? '0.0.0',
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...DESKTOP_MANAGED_BUNDLES, ...customBundles],
      },
    },
    dshDesktop: {
      ...manifest.dshDesktop,
      schemaVersion: DESKTOP_PROFILE_SCHEMA_VERSION,
      productVersion: options.productVersion,
      managedBundles: [...DESKTOP_MANAGED_BUNDLES],
    },
  }
  writeJsonAtomically(manifestPath, nextManifest)

  if (!existsSync(patchPath)) writeFileSync(patchPath, '[]\n', { mode: 0o600 })

  for (const [packageName, relativeDir] of Object.entries(DESKTOP_PACKAGES)) {
    ensurePackageLink(
      profileDir,
      packageName,
      resolveDesktopPackageTarget(options.packageRoot, packageName, relativeDir),
    )
  }

  return { profileDir, manifestPath, patchPath }
}

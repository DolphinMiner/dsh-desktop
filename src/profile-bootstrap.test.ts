import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  bootstrapDesktopProfile,
  DESKTOP_MANAGED_BUNDLES,
  DESKTOP_PACKAGES,
} from './profile-bootstrap'

async function createPackageRoot(root: string): Promise<string> {
  const packageRoot = join(root, 'app')
  for (const [name, relativeDir] of Object.entries(DESKTOP_PACKAGES)) {
    const directory = join(packageRoot, 'packages', relativeDir)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name })}\n`)
  }
  return packageRoot
}

async function withRoot(run: (root: string, packageRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-profile-'))
  try {
    await run(root, await createPackageRoot(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('creates the managed desktop profile and package links', async () => {
  await withRoot(async (root, packageRoot) => {
    const paths = bootstrapDesktopProfile({
      dshHome: join(root, 'home'),
      packageRoot,
      productVersion: '0.2.0',
    })
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, DESKTOP_MANAGED_BUNDLES)
    assert.equal(manifest.dshDesktop.schemaVersion, 1)
    assert.equal(await readFile(paths.patchPath, 'utf8'), '[]\n')

    for (const [name, relativeDir] of Object.entries(DESKTOP_PACKAGES)) {
      const link = join(paths.profileDir, 'node_modules', ...name.split('/'))
      assert.equal((await lstat(link)).isSymbolicLink(), true)
      assert.equal(resolve(dirname(link), await readlink(link)), resolve(packageRoot, 'packages', relativeDir))
    }
  })
})

test('migrates managed fields while preserving user bundles and patch content', async () => {
  await withRoot(async (root, packageRoot) => {
    const profileDir = join(root, 'home', 'profiles', 'desktop')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'custom-name',
      dependencies: { 'user-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'user-bundle'] } },
      dshDesktop: { schemaVersion: 0, managedBundles: ['old-desktop-bundle'], note: 'keep' },
    })}\n`)
    await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: user-row\n  disabled: true\n')

    const paths = bootstrapDesktopProfile({
      dshHome: join(root, 'home'),
      packageRoot,
      productVersion: '0.2.0',
    })
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [...DESKTOP_MANAGED_BUNDLES, 'user-bundle'])
    assert.deepEqual(manifest.dependencies, { 'user-plugin': '1.0.0' })
    assert.equal(manifest.dshDesktop.note, 'keep')
    assert.equal(await readFile(paths.patchPath, 'utf8'), '- id: user-row\n  disabled: true\n')
  })
})

test('does not overwrite an invalid manifest or an occupied package path', async () => {
  await withRoot(async (root, packageRoot) => {
    const profileDir = join(root, 'home', 'profiles', 'desktop')
    await mkdir(profileDir, { recursive: true })
    const manifestPath = join(profileDir, 'package.json')
    await writeFile(manifestPath, '{broken')
    assert.throws(() => bootstrapDesktopProfile({
      dshHome: join(root, 'home'),
      packageRoot,
      productVersion: '0.2.0',
    }), /invalid JSON/)
    assert.equal(await readFile(manifestPath, 'utf8'), '{broken')

    await writeFile(manifestPath, '{}\n')
    const occupied = join(profileDir, 'node_modules', '@dolphinminer', 'dsh-desktop-host')
    await mkdir(occupied, { recursive: true })
    assert.throws(() => bootstrapDesktopProfile({
      dshHome: join(root, 'home'),
      packageRoot,
      productVersion: '0.2.0',
    }), /will not replace the existing non-link package/)
  })
})

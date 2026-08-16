import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  DshPluginCommandRunner,
  DshPluginInstaller,
  parseRegistryPluginSpec,
  PluginInstallCommandResult,
  PluginInstallCommandRunner,
} from './plugin-installer'
import { bootstrapDesktopProfile } from './profile-bootstrap'

interface MutableManifest {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
}

class FakeRunner implements PluginInstallCommandRunner {
  readonly calls: string[][] = []
  active = 0
  maxActive = 0
  disposed = false

  constructor(
    private readonly manifestPath: string,
    private readonly packageName: string,
    private readonly mode: 'bundle' | 'plain' | 'failure' = 'bundle',
  ) {}

  async run(args: readonly string[]): Promise<PluginInstallCommandResult> {
    this.calls.push([...args])
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await new Promise(resolve => setTimeout(resolve, 5))
    try {
      if (this.mode === 'failure') return { exitCode: 1, stderr: 'failed' }
      const manifest = JSON.parse(await readFile(this.manifestPath, 'utf8')) as MutableManifest
      if (args[0] === 'add') {
        manifest.dependencies[this.packageName] = String(args[1])
        if (this.mode === 'bundle') manifest.dsh.profile.bundles.push(this.packageName)
      } else if (args[0] === 'remove') {
        delete manifest.dependencies[this.packageName]
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== this.packageName)
      }
      await writeFile(this.manifestPath, `${JSON.stringify(manifest)}\n`)
      return { exitCode: 0, stderr: '' }
    } finally {
      this.active -= 1
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

async function fixture(): Promise<{
  root: string
  profileDir: string
  manifestPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-installer-'))
  const profileDir = join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  await writeFile(manifestPath, `${JSON.stringify({
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  })}\n`)
  return { root, profileDir, manifestPath }
}

test('accepts only bounded registry identities and protects product bundles', () => {
  assert.deepEqual(parseRegistryPluginSpec('@acme/dsh-plugin-review@1.2.3'), {
    packageName: '@acme/dsh-plugin-review',
    packageSpec: '@acme/dsh-plugin-review@1.2.3',
  })
  assert.deepEqual(parseRegistryPluginSpec('dsh-plugin-review@latest'), {
    packageName: 'dsh-plugin-review',
    packageSpec: 'dsh-plugin-review@latest',
  })
  assert.equal(parseRegistryPluginSpec('--dir=/tmp'), undefined)
  assert.equal(parseRegistryPluginSpec('github:owner/repo'), undefined)
  assert.equal(parseRegistryPluginSpec('@dolphinminer/dsh-desktop-bundle'), undefined)
})

test('installs a registry bundle once and serializes concurrent requests', async t => {
  const paths = await fixture()
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const runner = new FakeRunner(paths.manifestPath, '@acme/dsh-plugin-review')
  let restores = 0
  const installer = new DshPluginInstaller({
    profileDir: paths.profileDir,
    runner,
    restoreProfile: () => { restores += 1 },
  })
  t.after(() => installer.dispose())

  const [first, duplicate] = await Promise.all([
    installer.installRegistry({ packageSpec: '@acme/dsh-plugin-review@1.2.3' }),
    installer.installRegistry({ packageSpec: '@acme/dsh-plugin-review@1.2.3' }),
  ])
  assert.deepEqual(first, { packageName: '@acme/dsh-plugin-review', changed: true })
  assert.deepEqual(duplicate, { packageName: '@acme/dsh-plugin-review', changed: false })
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.maxActive, 1)
  assert.equal(restores, 1)
})

test('installs a selected local DSH bundle without exposing arbitrary package-manager arguments', async t => {
  const paths = await fixture()
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const pluginDir = join(paths.root, 'local plugin')
  await mkdir(pluginDir)
  await writeFile(join(pluginDir, 'package.json'), `${JSON.stringify({
    name: '@acme/local-plugin',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })}\n`)
  const runner = new FakeRunner(paths.manifestPath, '@acme/local-plugin')
  const installer = new DshPluginInstaller({
    profileDir: paths.profileDir,
    runner,
    restoreProfile: () => undefined,
  })
  t.after(() => installer.dispose())

  assert.deepEqual(await installer.installDirectory(pluginDir), {
    packageName: '@acme/local-plugin',
    changed: true,
  })
  assert.deepEqual(runner.calls[0], [
    'add',
    `link:${await realpath(pluginDir)}`,
    '--save-exact',
    '--reporter=append-only',
  ])
})

test('removes a package that official profile reconciliation does not recognize as a bundle', async t => {
  const paths = await fixture()
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const runner = new FakeRunner(paths.manifestPath, 'plain-package', 'plain')
  let restores = 0
  const installer = new DshPluginInstaller({
    profileDir: paths.profileDir,
    runner,
    restoreProfile: () => { restores += 1 },
  })
  t.after(() => installer.dispose())

  await assert.rejects(installer.installRegistry({ packageSpec: 'plain-package' }), /does not declare/)
  assert.deepEqual(runner.calls.map(args => args[0]), ['add', 'remove'])
  assert.equal(restores, 2)
  const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as MutableManifest
  assert.equal(manifest.dependencies['plain-package'], undefined)
})

test('fails closed when the official installer fails and rejects non-bundle directories', async t => {
  const paths = await fixture()
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const runner = new FakeRunner(paths.manifestPath, 'broken-plugin', 'failure')
  let restores = 0
  const installer = new DshPluginInstaller({
    profileDir: paths.profileDir,
    runner,
    restoreProfile: () => { restores += 1 },
  })
  t.after(() => installer.dispose())
  await assert.rejects(installer.installRegistry({ packageSpec: 'broken-plugin' }), /official DSH/)
  assert.equal(restores, 1)

  const plainDir = join(paths.root, 'plain')
  await mkdir(plainDir)
  await writeFile(join(plainDir, 'package.json'), '{"name":"plain-plugin"}\n')
  await assert.rejects(installer.installDirectory(plainDir), /does not declare/)
})

test('runs the bounded official DSH command with the desktop profile and bundled pnpm shim', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-command-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pnpmBin = join(root, 'pnpm.cjs')
  await writeFile(pnpmBin, '')
  const runner = new DshPluginCommandRunner({
    dshBin: join(process.cwd(), 'test', 'fixtures', 'fake-dsh-plugin-command.mjs'),
    dshHome: join(root, 'harness'),
    nodeExecutable: process.execPath,
    pnpmBin,
    shimDir: join(root, 'bin'),
    env: { ...process.env, DSH_PLUGIN_EXPECTED_HOME: join(root, 'harness') },
    timeoutMs: 2_000,
  })
  t.after(() => runner.dispose())

  assert.deepEqual(await runner.run(['add', 'fixture-plugin']), {
    exitCode: 0,
    stderr: 'fixture ok\n',
  })
  assert.match(await readFile(join(root, 'bin', 'pnpm'), 'utf8'), /ELECTRON_RUN_AS_NODE=1 exec/)
})

test('terminates a timed-out official plugin command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-command-timeout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pnpmBin = join(root, 'pnpm.cjs')
  await writeFile(pnpmBin, '')
  const runner = new DshPluginCommandRunner({
    dshBin: join(process.cwd(), 'test', 'fixtures', 'fake-dsh-plugin-command.mjs'),
    dshHome: join(root, 'harness'),
    nodeExecutable: process.execPath,
    pnpmBin,
    shimDir: join(root, 'bin'),
    env: { ...process.env, DSH_PLUGIN_FIXTURE_MODE: 'hang' },
    timeoutMs: 20,
  })
  t.after(() => runner.dispose())
  await assert.rejects(runner.run(['add', 'fixture-plugin']), /timed out/)
})

test('installs a real local bundle through the official DSH profile command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-real-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshHome = join(root, 'harness')
  const restoreProfile = (): void => {
    bootstrapDesktopProfile({ dshHome, packageRoot: process.cwd(), productVersion: '0.6.0' })
  }
  const profile = bootstrapDesktopProfile({
    dshHome,
    packageRoot: process.cwd(),
    productVersion: '0.6.0',
  })
  const runner = new DshPluginCommandRunner({
    dshBin: join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js'),
    dshHome,
    nodeExecutable: process.execPath,
    pnpmBin: join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs'),
    shimDir: join(root, 'bin'),
    timeoutMs: 30_000,
  })
  const installer = new DshPluginInstaller({
    profileDir: profile.profileDir,
    runner,
    restoreProfile,
  })
  t.after(() => installer.dispose())

  assert.deepEqual(await installer.installDirectory(join(process.cwd(), 'test', 'fixtures', 'marketplace-plugin')), {
    packageName: 'dsh-plugin-marketplace-fixture',
    changed: true,
  })
  const manifest = JSON.parse(await readFile(profile.manifestPath, 'utf8')) as MutableManifest
  assert.ok(Object.hasOwn(manifest.dependencies, 'dsh-plugin-marketplace-fixture'))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-plugin-marketplace-fixture'))
})

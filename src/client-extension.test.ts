import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()

test('packages desktop settings and navigation through the official Harness loader', async () => {
  const [manifestSource, patch, bundle] = await Promise.all([
    readFile(join(root, 'packages/desktop-client/package.json'), 'utf8'),
    readFile(join(root, 'packages/desktop-bundle/cordis.patch.yml'), 'utf8'),
    readFile(join(root, 'packages/desktop-client/lib/client.js'), 'utf8'),
  ])
  const manifest = JSON.parse(manifestSource) as {
    exports?: Record<string, unknown>
    dsh?: { client?: { inject?: unknown; platform?: unknown } }
  }

  assert.ok(manifest.exports?.['./client'])
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-settings',
  ])
  assert.match(patch, /name: '@dolphinminer\/dsh-desktop-client'/)
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundle, /id: "@dolphinminer\/dsh-desktop-client"/)
  assert.match(bundle, /id: "connections"/)
  assert.match(bundle, /id: "computer"/)
  assert.match(bundle, /id: "worktrees"/)
  assert.match(bundle, /id: "review"/)
  assert.match(bundle, /id: "desktop-settings"/)
  assert.match(bundle, /Screen Recording/)
  assert.match(bundle, /Allow for this session/)
  assert.match(bundle, /Recent actions/)
  assert.match(bundle, /grantPendingActions/)
  assert.match(bundle, /pauseActions/)
  assert.match(bundle, /resumeActions/)
  assert.match(bundle, /revokeActions/)
  assert.match(bundle, /previewCleanup/)
  assert.match(bundle, /confirmCleanup/)
  assert.match(bundle, /previewRecovery/)
  assert.match(bundle, /confirmRecovery/)
  assert.match(bundle, /previewHandoff/)
  assert.match(bundle, /confirmHandoff/)
  assert.match(bundle, /Recheck worktrees/)
  assert.match(bundle, /Keep worktree/)
  assert.match(bundle, /Keep interrupted worktree/)
  assert.match(bundle, /does not modify checkout files/)
  assert.match(bundle, /Forget missing worktree/)
  assert.match(bundle, /does not delete files or the Git branch/)
  assert.match(bundle, /Restore moved worktree/)
  assert.match(bundle, /preserving its branch, commit, and checkout files/)
  assert.match(bundle, /Stop tracking changed checkout/)
  assert.match(bundle, /without deleting or modifying its directory, files, Git metadata, or branch/)
  assert.match(bundle, /Ignored files stay only in this checkout/)
  assert.match(bundle, /Git review/)
  assert.match(bundle, /Last agent turn/)
  assert.match(bundle, /observed from/)
  assert.match(bundle, /Unresolved comments/)
  assert.match(bundle, /Stale anchor/)
  assert.match(bundle, /comments\.add/)
  assert.match(bundle, /comments\.remove/)
  assert.match(bundle, /project\.open/)
})

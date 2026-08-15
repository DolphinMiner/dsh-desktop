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
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-settings',
  ])
  assert.match(patch, /name: '@dolphinminer\/dsh-desktop-client'/)
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundle, /id: "@dolphinminer\/dsh-desktop-client"/)
  assert.match(bundle, /id: "connections"/)
  assert.match(bundle, /id: "computer"/)
  assert.match(bundle, /id: "desktop-settings"/)
  assert.match(bundle, /Screen Recording/)
  assert.match(bundle, /project\.open/)
})

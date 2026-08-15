import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()

test('packages desktop file tools through the product Harness bundle', async () => {
  const [manifestSource, patch, agent] = await Promise.all([
    readFile(join(root, 'packages/desktop-agent/package.json'), 'utf8'),
    readFile(join(root, 'packages/desktop-bundle/cordis.patch.yml'), 'utf8'),
    readFile(join(root, 'packages/desktop-agent/lib/index.js'), 'utf8'),
  ])
  const manifest = JSON.parse(manifestSource) as { peerDependencies?: Record<string, string> }

  assert.equal(manifest.peerDependencies?.['@dolphinminer/dsh-desktop-host'], '0.5.0')
  assert.match(patch, /id: desktop-agent\s+name: '@dolphinminer\/dsh-desktop-agent'/)
  assert.match(agent, /desktop_reveal_file/)
  assert.match(agent, /desktop_open_file/)
  assert.match(agent, /computer_get_permissions/)
  assert.match(agent, /computer_list_apps/)
  assert.match(agent, /computer_observe/)
})

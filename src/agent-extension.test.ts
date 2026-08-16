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

  assert.equal(manifest.peerDependencies?.['@dolphinminer/dsh-desktop-host'], '0.6.0')
  assert.match(patch, /id: desktop-agent\s+name: '@dolphinminer\/dsh-desktop-agent'/)
  assert.match(agent, /desktop_reveal_file/)
  assert.match(agent, /desktop_open_file/)
  assert.match(agent, /desktop_git_status/)
  assert.match(agent, /desktop_git_review/)
  assert.match(agent, /desktop_create_worktree/)
  assert.match(agent, /computer_get_permissions/)
  assert.match(agent, /computer_list_apps/)
  assert.match(agent, /computer_observe/)
  assert.match(agent, /computer_click/)
  assert.match(agent, /computer_click_at/)
  assert.match(agent, /computer_type/)
  assert.match(agent, /computer_key/)
  assert.match(agent, /computer_scroll/)
  assert.match(agent, /computer_scroll_at/)
  assert.match(agent, /browser_navigate/)
  assert.match(agent, /browser_observe/)
  assert.match(agent, /browser_click/)
  assert.match(agent, /browser_type/)
  assert.match(agent, /browser_scroll/)
  assert.match(agent, /browser_upload/)
})

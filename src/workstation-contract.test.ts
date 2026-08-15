import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

import { DESKTOP_MANAGED_BUNDLES } from './profile-bootstrap'

const resolveFromHere = createRequire(__filename)

function packageRoot(name: string): string {
  return dirname(resolveFromHere.resolve(`${name}/package.json`))
}

test('composes the official durable coding loop and diff UI into the desktop profile', async () => {
  assert.deepEqual(DESKTOP_MANAGED_BUNDLES.slice(0, 2), [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
  ])

  const [baseManifestSource, webManifestSource, webPatch, editTool, diffModel] = await Promise.all([
    readFile(join(packageRoot('@deepseek-ai/dsh-base'), 'package.json'), 'utf8'),
    readFile(join(packageRoot('@deepseek-ai/dsh-web-app'), 'package.json'), 'utf8'),
    readFile(join(packageRoot('@deepseek-ai/dsh-web-app'), 'cordis.patch.yml'), 'utf8'),
    readFile(join(packageRoot('@deepseek-ai/dsh-tool-str-replace-editor'), 'lib/index.js'), 'utf8'),
    readFile(join(
      packageRoot('@deepseek-ai/dsh-client-ui-tool'),
      'lib/types/client/tool/models/diff-card-model.d.ts',
    ), 'utf8'),
  ])
  const base = JSON.parse(baseManifestSource) as { dependencies?: Record<string, string> }
  const web = JSON.parse(webManifestSource) as { dependencies?: Record<string, string> }

  for (const dependency of [
    '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-str-replace-editor',
  ]) assert.ok(base.dependencies?.[dependency], `${dependency} must remain in the official base bundle`)
  for (const dependency of [
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-tool',
    '@deepseek-ai/dsh-client-ui-trajectory',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]) assert.ok(web.dependencies?.[dependency], `${dependency} must remain in the official web bundle`)

  assert.match(webPatch, /id: ui-tool\s+name: '@deepseek-ai\/dsh-client-ui-tool'/)
  assert.match(editTool, /card: "diff"/)
  assert.match(diffModel, /DiffBlock/)
})

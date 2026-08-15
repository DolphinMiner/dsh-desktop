import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(root, 'packages', 'desktop-client')
const moduleId = '@dolphinminer/dsh-desktop-client'
const external = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

const result = await build({
  entryPoints: [resolve(packageRoot, 'src', 'client.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  external,
  sourcemap: false,
  legalComments: 'none',
})

const body = result.outputFiles[0]?.text
if (body === undefined) throw new Error('The desktop client bundle produced no JavaScript output.')
const output = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(moduleId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  }
});
`

const outputPath = resolve(packageRoot, 'lib', 'client.js')
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, output, 'utf8')

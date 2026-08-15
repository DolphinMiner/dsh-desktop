import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

export function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`
  let descriptor: number | undefined
  try {
    const data = `${JSON.stringify(value, null, 2)}\n`
    descriptor = openSync(temporaryPath, 'w', 0o600)
    writeFileSync(descriptor, data, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, path)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    throw error
  }
}

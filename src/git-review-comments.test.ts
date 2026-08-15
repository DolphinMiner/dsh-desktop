import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GitReviewCommentStore, GitReviewCommentStoreError } from './git-review-comments'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const commonDir = '/repo/.git'
const anchor = {
  path: 'src/example.ts',
  side: 'new' as const,
  line: 12,
  blob: 'a'.repeat(40),
}

function clock(): () => Date {
  let timestamp = Date.parse('2026-08-16T12:00:00.000Z')
  return () => {
    const value = new Date(timestamp)
    timestamp += 1_000
    return value
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-comments-test-'))
  return { root, path: join(root, 'git-review-comments.v1.json') }
}

test('persists immutable anchors and deduplicates an identical create request', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const events: unknown[] = []
  const store = new GitReviewCommentStore(path, { now: clock(), onChange: event => events.push(event) })

  const first = store.add({
    id: firstId,
    repositoryCommonDir: commonDir,
    anchor,
    body: 'Keep this boundary explicit.',
  })
  const duplicate = store.add({
    id: firstId,
    repositoryCommonDir: commonDir,
    anchor,
    body: 'Keep this boundary explicit.',
  })

  assert.equal(first.revision, 1)
  assert.deepEqual(duplicate, first)
  assert.equal(events.length, 1)
  assert.deepEqual(new GitReviewCommentStore(path).snapshot(commonDir), first)
  assert.match(await readFile(path, 'utf8'), /"blob": "a{40}"/)
})

test('isolates repositories, removes durably, and rejects identifier reuse', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new GitReviewCommentStore(path, { now: clock() })
  store.add({ id: firstId, repositoryCommonDir: commonDir, anchor, body: 'First' })
  store.add({ id: secondId, repositoryCommonDir: '/other/.git', anchor, body: 'Second' })

  assert.equal(store.snapshot(commonDir).comments.length, 1)
  assert.throws(
    () => store.add({ id: firstId, repositoryCommonDir: commonDir, anchor, body: 'Changed' }),
    (error: GitReviewCommentStoreError) => error.code === 'DUPLICATE_REQUEST',
  )
  assert.throws(
    () => store.remove(commonDir, secondId),
    (error: GitReviewCommentStoreError) => error.code === 'NOT_FOUND',
  )
  assert.equal(store.remove(commonDir, firstId).comments.length, 0)
  assert.equal(new GitReviewCommentStore(path).snapshot(commonDir).comments.length, 0)
})

test('fails closed on corrupt state and leaves memory unchanged after a persistence failure', async t => {
  const corrupt = await fixture()
  t.after(() => rm(corrupt.root, { recursive: true, force: true }))
  await writeFile(corrupt.path, '{"schemaVersion":1,"revision":4,"comments":[{"body":"private"}]}')
  const unavailable = new GitReviewCommentStore(corrupt.path)
  assert.equal(unavailable.status().available, false)
  assert.throws(
    () => unavailable.snapshot(commonDir),
    (error: GitReviewCommentStoreError) => error.code === 'DESKTOP_UNAVAILABLE',
  )
  assert.match(await readFile(corrupt.path, 'utf8'), /private/)

  const failing = await fixture()
  t.after(() => rm(failing.root, { recursive: true, force: true }))
  const store = new GitReviewCommentStore(failing.path, {
    write: () => { throw new Error('disk full') },
  })
  assert.throws(
    () => store.add({ id: firstId, repositoryCommonDir: commonDir, anchor, body: 'Never durable' }),
    (error: GitReviewCommentStoreError) => error.code === 'DESKTOP_UNAVAILABLE',
  )
  assert.equal(store.status().revision, 0)
  assert.equal(store.status().available, false)
})

import { parsePatch } from 'diff'

export type ReviewDiffLineKind = 'context' | 'addition' | 'deletion' | 'metadata'

export interface ReviewDiffLine {
  kind: ReviewDiffLineKind
  oldLine?: number
  newLine?: number
  text: string
}

export interface ReviewDiffHunk {
  header: string
  lines: ReviewDiffLine[]
}

export interface ReviewPatchFile {
  path: string
  oldPath?: string
  oldBlob?: string
  newBlob?: string
  binary: boolean
  hunks: ReviewDiffHunk[]
}

function normalizeGitPath(value: string | undefined): string | undefined {
  if (value === undefined || value === '/dev/null') return undefined
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value
}

function parseGitBlobPairs(patch: string): Array<{ oldBlob?: string; newBlob?: string }> {
  const starts = [...patch.matchAll(/^diff --git /gm)].map(match => match.index)
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? patch.length
    const match = /^index ([a-f0-9]+)\.\.([a-f0-9]+)(?:\s|$)/m.exec(patch.slice(start, end))
    return match === null ? {} : { oldBlob: match[1], newBlob: match[2] }
  })
}

export function parseGitReviewPatch(patch: string): ReviewPatchFile[] {
  if (patch === '') return []
  const files = parsePatch(patch)
  const blobPairs = parseGitBlobPairs(patch)
  if (files.length !== blobPairs.length) {
    throw new Error('The Git patch has inconsistent file boundaries.')
  }
  return files.map((file, index) => {
    const oldPath = normalizeGitPath(file.oldFileName)
    const newPath = normalizeGitPath(file.newFileName)
    const path = newPath ?? oldPath
    if (path === undefined) throw new Error('The Git patch does not identify a file.')
    return {
      path,
      ...(oldPath === undefined || oldPath === path ? {} : { oldPath }),
      ...blobPairs[index],
      binary: file.isBinary === true,
      hunks: file.hunks.map(hunk => {
        let oldLine = hunk.oldStart
        let newLine = hunk.newStart
        const lines = hunk.lines.map(line => {
          if (line.startsWith('+')) {
            return { kind: 'addition' as const, newLine: newLine++, text: line.slice(1) }
          }
          if (line.startsWith('-')) {
            return { kind: 'deletion' as const, oldLine: oldLine++, text: line.slice(1) }
          }
          if (line.startsWith(' ')) {
            return {
              kind: 'context' as const,
              oldLine: oldLine++,
              newLine: newLine++,
              text: line.slice(1),
            }
          }
          return { kind: 'metadata' as const, text: line }
        })
        return {
          header: `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} ` +
            `+${String(hunk.newStart)},${String(hunk.newLines)} @@`,
          lines,
        }
      }),
    }
  })
}

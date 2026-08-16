import type { BrowserState } from '@dolphinminer/dsh-desktop-protocol'

export function activeBrowserAddress(
  state: Pick<BrowserState, 'tabs' | 'activeTabId'>,
): string {
  const tab = state.tabs.find(candidate => candidate.id === state.activeTabId)
  return tab === undefined || tab.url === 'about:blank' ? '' : tab.url
}

export function normalizeBrowserAddress(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  return /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export function normalizedBrowserPoint(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  frame: { pixelWidth: number; pixelHeight: number },
): { normalizedX: number; normalizedY: number } | undefined {
  if (bounds.width <= 0 || bounds.height <= 0 || frame.pixelWidth <= 0 || frame.pixelHeight <= 0) {
    return undefined
  }
  const scale = Math.min(bounds.width / frame.pixelWidth, bounds.height / frame.pixelHeight)
  const width = frame.pixelWidth * scale
  const height = frame.pixelHeight * scale
  const x = clientX - bounds.left - (bounds.width - width) / 2
  const y = clientY - bounds.top - (bounds.height - height) / 2
  if (x < 0 || y < 0 || x > width || y > height) return undefined
  return {
    normalizedX: Math.min(1, Math.max(0, x / width)),
    normalizedY: Math.min(1, Math.max(0, y / height)),
  }
}

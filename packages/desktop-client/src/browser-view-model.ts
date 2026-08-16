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

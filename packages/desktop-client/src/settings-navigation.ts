const SECTION_LABELS: Readonly<Record<string, readonly string[]>> = {
  automations: ['Tasks'],
  connections: ['Connections'],
  computer: ['Computer', 'Computer Control'],
  worktrees: ['Worktrees'],
  snapshots: ['App Snapshots'],
  browser: ['Browser'],
  plugins: ['Plugins', '插件'],
}

const MAX_ATTEMPTS = 20
const RETRY_DELAY_MS = 50

function waitForPaint(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
}

function buttonText(button: HTMLButtonElement): string {
  return button.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function settingsTrigger(): HTMLButtonElement | undefined {
  const candidates = [...document.querySelectorAll<HTMLButtonElement>(
    'button[aria-haspopup="dialog"][aria-expanded]',
  )]
  return candidates.find(button => buttonText(button) === 'Settings' || buttonText(button) === '设置') ??
    (candidates.length === 1 ? candidates[0] : undefined)
}

function settingsSectionButton(labels: readonly string[]): HTMLButtonElement | undefined {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
  if (dialog === null) return undefined
  return [...dialog.querySelectorAll<HTMLButtonElement>('nav button')]
    .find(button => labels.includes(buttonText(button)))
}

/**
 * Opens the one official Harness Settings shell. The current upstream shell
 * keeps navigation state component-local, so native deep links use its public
 * button semantics until Harness exposes a programmatic navigation service.
 */
export async function openOfficialSettings(sectionId?: string): Promise<void> {
  let trigger: HTMLButtonElement | undefined
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    trigger = settingsTrigger()
    if (trigger !== undefined) break
    await waitForPaint()
  }
  if (trigger === undefined) throw new Error('The official Harness Settings shell is unavailable.')
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  if (sectionId === undefined) return

  const labels = SECTION_LABELS[sectionId]
  if (labels === undefined) throw new Error(`The Settings section "${sectionId}" is not registered.`)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const section = settingsSectionButton(labels)
    if (section !== undefined) {
      section.click()
      return
    }
    await waitForPaint()
  }
  throw new Error(`The Settings section "${sectionId}" is unavailable.`)
}

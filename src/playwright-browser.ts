import { randomUUID } from 'node:crypto'

import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import type {
  BrowserStorageMode,
  BrowserTabSummary,
  BrowserUiKeyboardAction,
  DesktopProtocolError,
} from '@dolphinminer/dsh-desktop-protocol'

const MAX_TABS = 32
const MAX_ARIA_LENGTH = 60_000
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

type BrowserRole = Parameters<Page['getByRole']>[0]

export class ControlledBrowserError extends Error {
  constructor(
    readonly code: DesktopProtocolError['code'],
    message: string,
    readonly ambiguous = false,
  ) {
    super(message)
    this.name = 'ControlledBrowserError'
  }
}

export interface PlaywrightBrowserLaunchOptions {
  storageMode: BrowserStorageMode
  profilePath: string
  executablePath?: string
}

export interface BrowserEngineState {
  tabs: BrowserTabSummary[]
  activeTabId?: string
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserEngineObservation {
  tabId: string
  url: string
  title: string
  ariaSnapshot: string
  truncated: boolean
  screenshot?: {
    data: Uint8Array
    pixelWidth: number
    pixelHeight: number
  }
}

export interface BrowserEngine {
  start(options: PlaywrightBrowserLaunchOptions, signal: AbortSignal): Promise<void>
  stop(): Promise<void>
  state(): Promise<BrowserEngineState>
  navigate(url: string, newTab: boolean, signal: AbortSignal): Promise<void>
  observe(tabId: string | undefined, captureScreenshot: boolean, signal: AbortSignal): Promise<BrowserEngineObservation>
  click(tabId: string, role: string, name: string, exact: boolean, signal: AbortSignal): Promise<void>
  clickAt(
    tabId: string,
    normalizedX: number,
    normalizedY: number,
    button: 'left' | 'right',
    signal: AbortSignal,
  ): Promise<void>
  type(tabId: string, role: string, name: string, text: string, submit: boolean, signal: AbortSignal): Promise<void>
  select(tabId: string, name: string, option: string, exact: boolean, signal: AbortSignal): Promise<void>
  scroll(tabId: string, deltaX: number, deltaY: number, signal: AbortSignal): Promise<void>
  scrollAt(
    tabId: string,
    normalizedX: number,
    normalizedY: number,
    deltaX: number,
    deltaY: number,
    signal: AbortSignal,
  ): Promise<void>
  keyboard(tabId: string, actions: BrowserUiKeyboardAction[], signal: AbortSignal): Promise<void>
  activate(tabId: string): Promise<void>
  newTab(): Promise<void>
  closeTab(tabId: string): Promise<void>
  goBack(signal: AbortSignal): Promise<void>
  goForward(signal: AbortSignal): Promise<void>
  reload(signal: AbortSignal): Promise<void>
}

interface NavigationState {
  urls: string[]
  index: number
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The controlled browser operation was cancelled.', 'AbortError')
}

async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined)
  await page.waitForTimeout(120)
}

export class PlaywrightBrowserEngine implements BrowserEngine {
  private browser?: Browser
  private context?: BrowserContext
  private activePage?: Page
  private readonly pageIds = new WeakMap<Page, string>()
  private readonly registeredPages = new WeakSet<Page>()
  private readonly navigation = new Map<string, NavigationState>()
  private readonly loading = new Set<string>()

  async start(options: PlaywrightBrowserLaunchOptions, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (this.context !== undefined) return
    const launch = {
      channel: options.executablePath === undefined ? 'chrome' as const : undefined,
      executablePath: options.executablePath,
      headless: true,
      args: ['--disable-sync', '--no-default-browser-check'],
    }
    try {
      if (options.storageMode === 'persistent') {
        this.context = await chromium.launchPersistentContext(options.profilePath, {
          ...launch,
          acceptDownloads: false,
          viewport: DEFAULT_VIEWPORT,
        })
        this.browser = this.context.browser() ?? undefined
      } else {
        this.browser = await chromium.launch(launch)
        this.context = await this.browser.newContext({
          acceptDownloads: false,
          viewport: DEFAULT_VIEWPORT,
        })
      }
    } catch (error) {
      await this.stop()
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new ControlledBrowserError(
        'UNSUPPORTED',
        `The controlled browser could not start. Install Google Chrome or choose a supported browser. ${detail}`,
      )
    }
    throwIfAborted(signal)
    this.context.setDefaultTimeout(10_000)
    this.context.setDefaultNavigationTimeout(30_000)
    this.context.on('page', page => this.registerPage(page, true))
    const pages = this.context.pages()
    if (pages.length === 0) {
      this.registerPage(await this.context.newPage(), true)
    } else {
      for (const page of pages) this.registerPage(page, false)
      this.activePage = pages[0]
    }
  }

  async stop(): Promise<void> {
    const context = this.context
    const browser = this.browser
    this.context = undefined
    this.browser = undefined
    this.activePage = undefined
    this.navigation.clear()
    this.loading.clear()
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }

  async state(): Promise<BrowserEngineState> {
    const context = this.requireContext()
    const pages = context.pages().slice(0, MAX_TABS)
    const tabs = await Promise.all(pages.map(async page => {
      const id = this.pageId(page)
      return {
        id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        loading: this.loading.has(id),
      }
    }))
    if (this.activePage === undefined || this.activePage.isClosed()) this.activePage = pages[0]
    const activeTabId = this.activePage === undefined ? undefined : this.pageId(this.activePage)
    const navigation = activeTabId === undefined ? undefined : this.navigation.get(activeTabId)
    return {
      tabs,
      ...(activeTabId === undefined ? {} : { activeTabId }),
      canGoBack: navigation !== undefined && navigation.index > 0,
      canGoForward: navigation !== undefined && navigation.index < navigation.urls.length - 1,
    }
  }

  async navigate(url: string, newTab: boolean, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const context = this.requireContext()
    const page = newTab || this.activePage === undefined || this.activePage.isClosed()
      ? await this.createPage(context)
      : this.activePage
    const id = this.pageId(page)
    this.loading.add(id)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await settlePage(page)
      throwIfAborted(signal)
      this.recordNavigation(page, page.url())
      this.activePage = page
    } finally {
      this.loading.delete(id)
    }
  }

  async observe(
    tabId: string | undefined,
    captureScreenshot: boolean,
    signal: AbortSignal,
  ): Promise<BrowserEngineObservation> {
    throwIfAborted(signal)
    const page = this.page(tabId)
    this.activePage = page
    await settlePage(page)
    const rawAria = await page.locator('body').ariaSnapshot({ timeout: 10_000 }).catch(() => '')
    const ariaSnapshot = rawAria.slice(0, MAX_ARIA_LENGTH)
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT
    const screenshot = captureScreenshot
      ? new Uint8Array(await page.screenshot({
          type: 'jpeg',
          quality: 76,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
        }))
      : undefined
    throwIfAborted(signal)
    this.recordNavigation(page, page.url())
    return {
      tabId: this.pageId(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
      ariaSnapshot,
      truncated: rawAria.length > MAX_ARIA_LENGTH,
      ...(screenshot === undefined ? {} : {
        screenshot: {
          data: screenshot,
          pixelWidth: viewport.width,
          pixelHeight: viewport.height,
        },
      }),
    }
  }

  async click(
    tabId: string,
    role: string,
    name: string,
    exact: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    const page = this.page(tabId)
    const locator = page.getByRole(role as BrowserRole, { name, exact })
    await this.requireOne(locator.count(), role, name)
    await locator.click()
    await settlePage(page)
    throwIfAborted(signal)
  }

  async clickAt(
    tabId: string,
    normalizedX: number,
    normalizedY: number,
    button: 'left' | 'right',
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    const page = this.page(tabId)
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT
    await page.mouse.click(
      normalizedX * viewport.width,
      normalizedY * viewport.height,
      { button },
    )
    await settlePage(page)
    throwIfAborted(signal)
  }

  async type(
    tabId: string,
    role: string,
    name: string,
    text: string,
    submit: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    const page = this.page(tabId)
    const locator = page.getByRole(role as BrowserRole, { name, exact: true })
    await this.requireOne(locator.count(), role, name)
    await locator.fill(text)
    if (submit) await locator.press('Enter')
    await settlePage(page)
    throwIfAborted(signal)
  }

  async select(
    tabId: string,
    name: string,
    option: string,
    exact: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    const page = this.page(tabId)
    const locator = page.getByRole('combobox', { name, exact })
    await this.requireOne(locator.count(), 'combobox', name)
    await this.requireOne(locator.getByRole('option', { name: option, exact: true }).count(), 'option', option)
    await locator.selectOption({ label: option })
    await settlePage(page)
    throwIfAborted(signal)
  }

  async scroll(tabId: string, deltaX: number, deltaY: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const page = this.page(tabId)
    await page.mouse.wheel(deltaX, deltaY)
    await page.waitForTimeout(120)
    throwIfAborted(signal)
  }

  async scrollAt(
    tabId: string,
    normalizedX: number,
    normalizedY: number,
    deltaX: number,
    deltaY: number,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    const page = this.page(tabId)
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT
    await page.mouse.move(normalizedX * viewport.width, normalizedY * viewport.height)
    await page.mouse.wheel(deltaX, deltaY)
    await page.waitForTimeout(120)
    throwIfAborted(signal)
  }

  async keyboard(
    tabId: string,
    actions: BrowserUiKeyboardAction[],
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    const page = this.page(tabId)
    for (const action of actions) {
      throwIfAborted(signal)
      if (action.kind === 'text') {
        await page.keyboard.insertText(action.text)
        continue
      }
      const modifiers = action.modifiers ?? []
      for (const modifier of modifiers) await page.keyboard.down(modifier)
      try {
        await page.keyboard.press(action.key)
      } finally {
        for (const modifier of modifiers.slice().reverse()) await page.keyboard.up(modifier)
      }
    }
    await settlePage(page)
    throwIfAborted(signal)
  }

  async activate(tabId: string): Promise<void> {
    this.activePage = this.page(tabId)
  }

  async newTab(): Promise<void> {
    await this.createPage(this.requireContext())
  }

  async closeTab(tabId: string): Promise<void> {
    const page = this.page(tabId)
    await page.close()
    this.navigation.delete(tabId)
    this.loading.delete(tabId)
    const pages = this.requireContext().pages()
    if (pages.length === 0) await this.createPage(this.requireContext())
    else if (this.activePage === page) this.activePage = pages[0]
  }

  async goBack(signal: AbortSignal): Promise<void> {
    const page = this.page()
    const id = this.pageId(page)
    const state = this.navigation.get(id)
    if (state === undefined || state.index === 0) return
    await page.goBack({ waitUntil: 'domcontentloaded' })
    await settlePage(page)
    throwIfAborted(signal)
    state.index -= 1
    state.urls[state.index] = page.url()
  }

  async goForward(signal: AbortSignal): Promise<void> {
    const page = this.page()
    const id = this.pageId(page)
    const state = this.navigation.get(id)
    if (state === undefined || state.index >= state.urls.length - 1) return
    await page.goForward({ waitUntil: 'domcontentloaded' })
    await settlePage(page)
    throwIfAborted(signal)
    state.index += 1
    state.urls[state.index] = page.url()
  }

  async reload(signal: AbortSignal): Promise<void> {
    const page = this.page()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await settlePage(page)
    throwIfAborted(signal)
  }

  private requireContext(): BrowserContext {
    if (this.context === undefined) {
      throw new ControlledBrowserError('CONFLICT', 'The controlled browser is not running.')
    }
    return this.context
  }

  private page(tabId?: string): Page {
    const pages = this.requireContext().pages()
    const page = tabId === undefined
      ? this.activePage
      : pages.find(candidate => this.pageId(candidate) === tabId)
    if (page === undefined || page.isClosed()) {
      throw new ControlledBrowserError('NOT_FOUND', 'The controlled browser tab is no longer available.')
    }
    return page
  }

  private async createPage(context: BrowserContext): Promise<Page> {
    if (context.pages().length >= MAX_TABS) {
      throw new ControlledBrowserError('CONFLICT', `The controlled browser supports at most ${String(MAX_TABS)} tabs.`)
    }
    const page = await context.newPage()
    this.registerPage(page, true)
    return page
  }

  private registerPage(page: Page, activate: boolean): void {
    const id = this.pageId(page)
    if (activate) this.activePage = page
    if (this.registeredPages.has(page)) return
    this.registeredPages.add(page)
    if (!this.navigation.has(id)) this.navigation.set(id, { urls: [page.url()], index: 0 })
    page.once('close', () => {
      this.navigation.delete(id)
      this.loading.delete(id)
      if (this.activePage === page) this.activePage = this.context?.pages()[0]
    })
  }

  private pageId(page: Page): string {
    const current = this.pageIds.get(page)
    if (current !== undefined) return current
    const id = randomUUID()
    this.pageIds.set(page, id)
    return id
  }

  private recordNavigation(page: Page, url: string): void {
    const id = this.pageId(page)
    const current = this.navigation.get(id) ?? { urls: [], index: -1 }
    if (current.urls[current.index] === url) return
    current.urls = current.urls.slice(0, current.index + 1)
    current.urls.push(url)
    current.index = current.urls.length - 1
    this.navigation.set(id, current)
  }

  private async requireOne(countPromise: Promise<number>, role: string, name: string): Promise<void> {
    const count = await countPromise
    if (count === 1) return
    if (count === 0) {
      throw new ControlledBrowserError('NOT_FOUND', `No ${role} named "${name}" exists in the current page.`)
    }
    throw new ControlledBrowserError(
      'CONFLICT',
      `More than one ${role} named "${name}" exists. Observe again and use a more specific accessible name.`,
    )
  }
}

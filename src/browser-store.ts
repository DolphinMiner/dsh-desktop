import {
  BrowserHistoryEntry,
  BrowserSettings,
  parseBrowserHistory,
  parseBrowserSettings,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

const BROWSER_STORE_SCHEMA_VERSION = 1
const MAX_HISTORY_ENTRIES = 500

interface BrowserStoreDocument {
  schemaVersion: typeof BROWSER_STORE_SCHEMA_VERSION
  settings: BrowserSettings
  history: BrowserHistoryEntry[]
}

export interface BrowserStoredState {
  settings: BrowserSettings
  history: BrowserHistoryEntry[]
  recovered: boolean
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: false,
  webUrlTarget: 'system',
  localUrlTarget: 'controlled',
  screenshotPolicy: 'always',
  storageMode: 'isolated',
}

function cloneSettings(settings: BrowserSettings): BrowserSettings {
  return { ...settings }
}

function cloneHistory(history: BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  return history.map(entry => ({ ...entry }))
}

export class BrowserStore {
  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  load(): BrowserStoredState {
    try {
      const value = readJsonFile(this.path)
      if (value === undefined) {
        return {
          settings: cloneSettings(DEFAULT_BROWSER_SETTINGS),
          history: [],
          recovered: false,
        }
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('The Browser settings file has an invalid shape.')
      }
      const document = value as Partial<BrowserStoreDocument>
      const settings = parseBrowserSettings(document.settings)
      const history = parseBrowserHistory(document.history)
      if (document.schemaVersion !== BROWSER_STORE_SCHEMA_VERSION || settings === undefined ||
        history === undefined || history.length > MAX_HISTORY_ENTRIES) {
        throw new Error('The Browser settings file uses an unsupported schema.')
      }
      return {
        settings: cloneSettings(settings),
        history: cloneHistory(history),
        recovered: false,
      }
    } catch (error) {
      this.onError(error)
      return {
        settings: cloneSettings(DEFAULT_BROWSER_SETTINGS),
        history: [],
        recovered: true,
      }
    }
  }

  save(settings: BrowserSettings, history: BrowserHistoryEntry[]): void {
    writeJsonAtomically(this.path, {
      schemaVersion: BROWSER_STORE_SCHEMA_VERSION,
      settings: cloneSettings(settings),
      history: cloneHistory(history.slice(0, MAX_HISTORY_ENTRIES)),
    } satisfies BrowserStoreDocument)
  }
}

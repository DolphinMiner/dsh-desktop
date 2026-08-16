export type DesktopAccessoryView = 'launcher' | 'files' | 'browser' | 'terminal'

export interface DesktopAccessorySnapshot {
  open: boolean
  view: DesktopAccessoryView
}

const CLOSED: DesktopAccessorySnapshot = { open: false, view: 'launcher' }

export class DesktopAccessoryController {
  #snapshot: DesktopAccessorySnapshot = CLOSED
  readonly #listeners = new Set<() => void>()

  readonly getSnapshot = (): DesktopAccessorySnapshot => this.#snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  open(view: DesktopAccessoryView = 'launcher'): void {
    this.#publish({ open: true, view })
  }

  close(): void {
    this.#publish(CLOSED)
  }

  toggle(): void {
    if (this.#snapshot.open) this.close()
    else this.open()
  }

  #publish(snapshot: DesktopAccessorySnapshot): void {
    if (this.#snapshot.open === snapshot.open && this.#snapshot.view === snapshot.view) return
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}

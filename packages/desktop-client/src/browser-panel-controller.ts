export class BrowserPanelController {
  #open = false
  readonly #listeners = new Set<() => void>()

  readonly getSnapshot = (): boolean => this.#open

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  setOpen(open: boolean): void {
    if (this.#open === open) return
    this.#open = open
    for (const listener of this.#listeners) listener()
  }

  toggle(): void {
    this.setOpen(!this.#open)
  }
}

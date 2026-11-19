import type { Context } from './context.ts'
import { reportListenerError } from './realm.ts'

type Listener = { fn: (...args: unknown[]) => unknown; options?: unknown }

/** One chrome.* event (runtime.onMessage, tabs.onUpdated...) in one context. */
export class ChromeEvent {
  readonly name: string
  readonly ctx: Context
  listeners: Listener[] = []
  readonly api: Record<string, unknown>

  constructor(ctx: Context, name: string) {
    this.ctx = ctx
    this.name = name
    const find = (fn: unknown) => this.listeners.findIndex((listener) => listener.fn === fn)
    this.api = {
      addListener: (fn: unknown, options?: unknown) => {
        if (typeof fn !== 'function') throw new ctx.window.TypeError(`${name}.addListener needs a function`)
        if (find(fn) < 0) this.listeners.push({ fn: fn as Listener['fn'], options })
      },
      removeListener: (fn: unknown) => {
        const index = find(fn)
        if (index >= 0) this.listeners.splice(index, 1)
      },
      hasListener: (fn: unknown) => find(fn) >= 0,
      hasListeners: () => this.listeners.length > 0,
      addRules: () => {},
      removeRules: () => {},
      getRules: () => {},
    }
  }

  /** Calls every listener; returns what each returned. */
  dispatch(args: unknown[], accept?: (options: unknown) => boolean): unknown[] {
    if (!this.ctx.alive) return []
    const results: unknown[] = []
    for (const listener of [...this.listeners]) {
      if (accept && !accept(listener.options)) continue
      try {
        results.push(listener.fn(...args))
      } catch (error) {
        reportListenerError(this.ctx, error)
      }
    }
    return results
  }
}

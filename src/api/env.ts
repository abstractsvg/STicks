import { eventOf, type Context, type Extension } from '../context.ts'
import { method, syncMethod } from '../realm.ts'
import type { Sticks } from '../sticks.ts'

export interface Env {
  s: Sticks
  ctx: Context
  ext: Extension
  /** a promise-or-callback chrome.* method */
  m: (run: (...args: any[]) => unknown, options?: { voidResult?: boolean }) => (...args: unknown[]) => unknown
  /** a synchronous chrome.* method */
  sync: (run: (...args: any[]) => unknown) => (...args: unknown[]) => unknown
  /** this context's chrome.* event of that name */
  event: (name: string) => Record<string, unknown>
  /** a plain object made in the extension's realm */
  obj: <T extends object>(props: T) => T
}

export function makeEnv(s: Sticks, ctx: Context): Env {
  return {
    s,
    ctx,
    ext: ctx.ext,
    m: (run, options) => method(ctx, run, options),
    sync: (run) => syncMethod(ctx, run),
    event: (name) => eventOf(ctx, name).api,
    obj: <T extends object>(props: T) => Object.defineProperties(new ctx.window.Object(), Object.getOwnPropertyDescriptors(props)) as T,
  }
}

/** A namespace STicks has no emulation for, granted by a permission: calls resolve, events never fire. */
export function stubNamespace(env: Env, name: string): unknown {
  const make = (path: string): unknown =>
    new Proxy(function stub() {}, {
      get(_target, key) {
        if (typeof key === 'symbol') return undefined
        if (key === 'then') return undefined
        if (/^on[A-Z]/.test(key)) return env.event(`${path}.${key}`)
        return make(`${path}.${key}`)
      },
      apply(_target, _that, args) {
        const callback = typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as () => void) : null
        if (callback) {
          setTimeout(() => callback(), 0)
          return undefined
        }
        return env.ctx.window.Promise.resolve(undefined)
      },
    })
  return make(name)
}

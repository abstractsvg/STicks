import type { Context } from './context.ts'

/** An error chrome.* reports through runtime.lastError or a rejected promise. */
export class ApiError extends Error {}

const RAW = Symbol('sticks raw')

/** Hand a value to the caller as it is (a Window, an object that must stay live). */
export function raw<T>(value: T): T {
  return { [RAW]: value } as unknown as T
}

export type Realm = Window & typeof globalThis

/** A copy made with the target realm's own JSON, as Chrome serializes messages and storage. */
export function toRealm<T>(win: Realm, value: T): T {
  if (value === undefined || value === null) return value
  if (typeof value === 'object' && RAW in (value as object)) return (value as Record<symbol, T>)[RAW]
  if (typeof value !== 'object') return value
  try {
    return win.JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

export const messageOf = (error: unknown) => (error instanceof Error || (error && typeof error === 'object' && 'message' in error) ? String((error as Error).message) : String(error))

export function reportListenerError(ctx: Context, error: unknown) {
  console.error(`[sticks] ${ctx.ext.manifest.name}: error in event handler`, error)
}

function callback(ctx: Context, cb: (...args: unknown[]) => unknown, error: unknown, value: unknown, hasValue: boolean) {
  if (!ctx.alive) return
  ctx.lastError = error === undefined ? undefined : toRealm(ctx.window, { message: messageOf(error) })
  ctx.lastErrorChecked = false
  try {
    if (error !== undefined || !hasValue) cb()
    else cb(toRealm(ctx.window, value))
  } catch (thrown) {
    reportListenerError(ctx, thrown)
  } finally {
    if (ctx.lastError && !ctx.lastErrorChecked) console.error(`Unchecked runtime.lastError: ${ctx.lastError.message}`)
    ctx.lastError = undefined
  }
}

/**
 * A chrome.* method: promise-returning, or callback-taking when the last
 * argument is a function, with runtime.lastError set during the callback.
 */
export function method(ctx: Context, run: (...args: unknown[]) => unknown, { voidResult = false } = {}) {
  return (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (...values: unknown[]) => unknown) : null
    let result: Promise<unknown>
    try {
      result = Promise.resolve(run(...args))
    } catch (error) {
      result = Promise.reject(error)
    }
    if (cb) {
      result.then(
        (value) => callback(ctx, cb, undefined, value, !voidResult),
        (error: unknown) => callback(ctx, cb, error ?? new Error('unknown error'), undefined, false),
      )
      return undefined
    }
    const win = ctx.window
    return new win.Promise((resolve, reject) => {
      result.then(
        (value) => resolve(voidResult ? undefined : toRealm(win, value)),
        (error: unknown) => reject(new win.Error(messageOf(error))),
      )
    })
  }
}

/** A synchronous chrome.* method (getURL, getManifest, getMessage). */
export function syncMethod(ctx: Context, run: (...args: unknown[]) => unknown) {
  return (...args: unknown[]) => {
    try {
      return toRealm(ctx.window, run(...args))
    } catch (error) {
      throw new ctx.window.Error(messageOf(error))
    }
  }
}

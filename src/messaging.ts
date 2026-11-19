import { eventOf, type Context } from './context.ts'
import { ApiError, reportListenerError, toRealm } from './realm.ts'

export const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'

export interface Sender {
  id: string
  url?: string
  origin?: string
  tab?: unknown
  frameId?: number
  documentId?: string
}

/**
 * runtime.sendMessage / tabs.sendMessage: every onMessage listener in the
 * targets gets the message; the first sendResponse wins, and a listener that
 * returns true or a promise keeps the channel open.
 */
export function deliverMessage(targets: Context[], event: string, message: unknown, sender: Sender): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    let listeners = 0
    let open = 0
    const text = JSON.stringify(message ?? null)
    const finish = (value: unknown) => {
      if (settled) return
      settled = true
      resolve(value === undefined ? undefined : JSON.parse(JSON.stringify(value) ?? 'null'))
    }
    for (const ctx of targets) {
      const chromeEvent = ctx.events.get(event)
      if (!ctx.alive || !chromeEvent?.listeners.length) continue
      for (const listener of [...chromeEvent.listeners]) {
        listeners++
        let result: unknown
        try {
          result = listener.fn(toRealm(ctx.window, JSON.parse(text)), toRealm(ctx.window, sender), (response?: unknown) => finish(response))
        } catch (error) {
          reportListenerError(ctx, error)
          continue
        }
        if (result === true) open++
        else if (result && typeof (result as Promise<unknown>).then === 'function') {
          open++
          ;(result as Promise<unknown>).then(finish, (error: unknown) => {
            reportListenerError(ctx, error)
            finish(undefined)
          })
        }
      }
    }
    if (!listeners) reject(new ApiError(NO_RECEIVER))
    else if (!open) queueMicrotask(() => finish(undefined))
  })
}

class PortEnd {
  readonly ctx: Context
  readonly links = new Set<PortEnd>()
  connected = true
  linked = false
  readonly queue: string[] = []
  readonly object: Record<string, unknown>
  private readonly onMessage
  private readonly onDisconnect

  constructor(ctx: Context, name: string, sender: Sender | undefined) {
    this.ctx = ctx
    const key = `port:${Math.random().toString(36).slice(2)}`
    this.onMessage = eventOf(ctx, `${key}.onMessage`)
    this.onDisconnect = eventOf(ctx, `${key}.onDisconnect`)
    this.object = Object.assign(new ctx.window.Object() as Record<string, unknown>, {
      name,
      ...(sender ? { sender: toRealm(ctx.window, sender) } : {}),
      onMessage: this.onMessage.api,
      onDisconnect: this.onDisconnect.api,
      postMessage: (message: unknown) => this.post(message),
      disconnect: () => this.disconnect(),
    })
    ctx.disposers.push(() => this.disconnect())
  }

  post(message: unknown) {
    if (!this.connected) throw new this.ctx.window.Error('Attempting to use a disconnected port object')
    const text = JSON.stringify(message ?? null)
    if (!this.linked) {
      this.queue.push(text)
      return
    }
    for (const other of this.links) other.receive(text)
  }

  receive(text: string) {
    setTimeout(() => {
      if (this.connected) this.onMessage.dispatch([toRealm(this.ctx.window, JSON.parse(text)), this.object])
    }, 0)
  }

  flush() {
    this.linked = true
    for (const text of this.queue.splice(0)) for (const other of this.links) other.receive(text)
  }

  disconnect() {
    if (!this.connected) return
    this.connected = false
    for (const other of this.links) {
      other.links.delete(this)
      if (other.links.size === 0 && other.connected) {
        other.connected = false
        other.onDisconnect.dispatch([other.object])
      }
    }
    this.links.clear()
  }

  fail(message: string) {
    if (!this.connected) return
    this.connected = false
    this.ctx.lastError = toRealm(this.ctx.window, { message })
    this.onDisconnect.dispatch([this.object])
    this.ctx.lastError = undefined
  }
}

/**
 * runtime.connect / tabs.connect: a port to every target that listens for
 * onConnect once `ready` settles (the background may still be loading);
 * messages posted before then are queued.
 */
export function openPort(from: Context, targets: () => Context[], event: string, name: string, sender: Sender, ready: Promise<void> = Promise.resolve()) {
  const source = new PortEnd(from, name, undefined)
  ready.then(() => {
    if (!source.connected) return
    for (const ctx of targets()) {
      const listeners = ctx.events.get(event)
      if (!ctx.alive || !listeners?.listeners.length) continue
      const end = new PortEnd(ctx, name, sender)
      end.linked = true
      end.links.add(source)
      source.links.add(end)
      listeners.dispatch([end.object])
    }
    if (!source.links.size) source.fail(NO_RECEIVER)
    else source.flush()
  })
  return source.object
}

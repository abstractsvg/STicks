import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createContext, eventOf, type Context, type Extension } from '../src/context.ts'
import { deliverMessage, NO_RECEIVER, openPort } from '../src/messaging.ts'
import { method } from '../src/realm.ts'

const ext = { id: 'a'.repeat(32), manifest: { name: 'test' } } as unknown as Extension
const realm = globalThis as unknown as Context['window']
const context = (kind: Context['kind'] = 'background') => createContext({ ext, kind, window: realm, tabId: null, frameId: 0, url: 'https://x/' })
const sender = { id: ext.id }
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('sendResponse answers, the first answer wins, messages are copies', async () => {
  const target = context()
  const original = { n: 1 }
  ;(eventOf(target, 'runtime.onMessage').api.addListener as (fn: unknown) => void)((message: { n: number }, _sender: unknown, reply: (value: unknown) => void) => {
    message.n = 99
    reply({ got: 1 })
    reply({ got: 2 })
  })
  assert.deepEqual(await deliverMessage([target], 'runtime.onMessage', original, sender), { got: 1 })
  assert.equal(original.n, 1)
})

test('returning true or a promise keeps the channel open', async () => {
  const target = context()
  const add = eventOf(target, 'runtime.onMessage').api.addListener as (fn: unknown) => void
  add((_message: unknown, _sender: unknown, reply: (value: unknown) => void) => {
    setTimeout(() => reply('later'), 10)
    return true
  })
  assert.equal(await deliverMessage([target], 'runtime.onMessage', null, sender), 'later')

  const other = context()
  ;(eventOf(other, 'runtime.onMessage').api.addListener as (fn: unknown) => void)(async () => 'from promise')
  assert.equal(await deliverMessage([other], 'runtime.onMessage', null, sender), 'from promise')
})

test('no listener means "Receiving end does not exist"', async () => {
  await assert.rejects(deliverMessage([context()], 'runtime.onMessage', 1, sender), { message: NO_RECEIVER })
})

test('ports: messages posted before the receiver connects are queued, disconnect reaches the other side', async () => {
  const from = context('popup')
  const to = context()
  const received: unknown[] = []
  let disconnected = false
  let release!: () => void
  const ready = new Promise<void>((resolve) => (release = resolve))
  ;(eventOf(to, 'runtime.onConnect').api.addListener as (fn: unknown) => void)((port: Record<string, Record<string, (fn: unknown) => void>>) => {
    port.onMessage.addListener((message: unknown) => received.push(message))
    port.onDisconnect.addListener(() => (disconnected = true))
  })
  const port = openPort(from, () => [to], 'runtime.onConnect', 'chan', sender, ready) as { postMessage: (m: unknown) => void; disconnect: () => void }
  port.postMessage({ early: true })
  release()
  await tick()
  port.postMessage({ late: true })
  await tick()
  assert.deepEqual(received, [{ early: true }, { late: true }])
  port.disconnect()
  assert.ok(disconnected)
})

test('method(): promises, callbacks and runtime.lastError', async () => {
  const ctx = context()
  const ok = method(ctx, (value: unknown) => ({ value }))
  assert.deepEqual(await ok(5), { value: 5 })
  const failing = method(ctx, () => {
    throw new Error('nope')
  })
  await assert.rejects(failing() as Promise<unknown>, { message: 'nope' })
  const seen = await new Promise<string | undefined>((resolve) => {
    failing(() => resolve(ctx.lastError?.message))
  })
  assert.equal(seen, 'nope')
  assert.equal(ctx.lastError, undefined, 'lastError is cleared after the callback')
})

import { ApiError, toRealm } from '../realm.ts'
import type { Env } from './env.ts'

type Area = 'local' | 'sync' | 'session' | 'managed'

const QUOTAS: Record<Area, Record<string, number>> = {
  local: { QUOTA_BYTES: 10_485_760 },
  sync: { QUOTA_BYTES: 102_400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512, MAX_WRITE_OPERATIONS_PER_HOUR: 1800, MAX_WRITE_OPERATIONS_PER_MINUTE: 120 },
  session: { QUOTA_BYTES: 10_485_760 },
  managed: {},
}

const copy = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

export function storage(env: Env) {
  const { s, ext } = env

  const fire = (area: Area, changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
    if (!Object.keys(changes).length) return
    if (area !== 'session' && area !== 'managed') s.saveStorage(ext, area)
    s.dispatch(ext.id, 'storage.onChanged', (ctx) => [toRealm(ctx.window, changes), area])
    s.dispatch(ext.id, `storage.${area}.onChanged`, (ctx) => [toRealm(ctx.window, changes)])
  }

  const select = (data: Record<string, unknown>, keys: unknown) => {
    if (keys === null || keys === undefined) return copy(data) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    if (typeof keys === 'string') {
      if (keys in data) out[keys] = copy(data[keys])
    } else if (Array.isArray(keys)) {
      for (const key of keys) if (String(key) in data) out[String(key)] = copy(data[String(key)])
    } else if (typeof keys === 'object') {
      for (const [key, fallback] of Object.entries(keys as Record<string, unknown>)) out[key] = key in data ? copy(data[key]) : copy(fallback)
    }
    return out
  }

  const area = (name: Area) => {
    const data = () => ext.storage[name]
    const writable = () => {
      if (name === 'managed') throw new ApiError('This is a read-only store.')
    }
    return env.obj({
      ...QUOTAS[name],
      get: env.m((keys?: unknown) => select(data(), keys)),
      getKeys: env.m(() => Object.keys(data())),
      set: env.m((items: Record<string, unknown>) => {
        writable()
        if (!items || typeof items !== 'object') throw new ApiError('Error in invocation of storage.set: items must be an object.')
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {}
        for (const [key, value] of Object.entries(items)) {
          if (value === undefined) continue
          const next = copy(value)
          const previous = data()[key]
          if (JSON.stringify(previous) === JSON.stringify(next)) continue
          changes[key] = previous === undefined ? { newValue: next } : { oldValue: copy(previous), newValue: next }
          data()[key] = next
        }
        fire(name, changes)
      }, { voidResult: true }),
      remove: env.m((keys: string | string[]) => {
        writable()
        const changes: Record<string, { oldValue?: unknown }> = {}
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (!(key in data())) continue
          changes[key] = { oldValue: copy(data()[key]) }
          delete data()[key]
        }
        fire(name, changes)
      }, { voidResult: true }),
      clear: env.m(() => {
        writable()
        const changes: Record<string, { oldValue?: unknown }> = {}
        for (const key of Object.keys(data())) changes[key] = { oldValue: copy(data()[key]) }
        ext.storage[name] = {}
        fire(name, changes)
      }, { voidResult: true }),
      getBytesInUse: env.m((keys?: unknown) => {
        const chosen = select(data(), keys ?? null)
        return Object.entries(chosen).reduce((sum, [key, value]) => sum + key.length + JSON.stringify(value).length, 0)
      }),
      setAccessLevel: env.m(() => {}, { voidResult: true }),
      onChanged: env.event(`storage.${name}.onChanged`),
    })
  }

  return env.obj({
    local: area('local'),
    sync: area('sync'),
    session: area('session'),
    managed: area('managed'),
    onChanged: env.event('storage.onChanged'),
    AccessLevel: { TRUSTED_CONTEXTS: 'TRUSTED_CONTEXTS', TRUSTED_AND_UNTRUSTED_CONTEXTS: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' },
  })
}

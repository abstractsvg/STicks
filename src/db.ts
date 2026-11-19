const DB_NAME = 'sticks'
const STORES = ['extensions', 'storage', 'state'] as const
export type StoreName = (typeof STORES)[number]

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      opening = null
      reject(request.error ?? new Error('could not open the sticks database'))
    }
  })
  return opening
}

function run<T>(store: StoreName, mode: IDBTransactionMode, job: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        const request = job(transaction.objectStore(store))
        transaction.oncomplete = () => resolve(request.result)
        transaction.onerror = () => reject(transaction.error ?? request.error)
        transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'))
      }),
  )
}

export const db = {
  get: <T>(store: StoreName, key: string) => run<T | undefined>(store, 'readonly', (objects) => objects.get(key)),
  put: (store: StoreName, key: string, value: unknown) => run(store, 'readwrite', (objects) => objects.put(value, key)).then(() => {}),
  delete: (store: StoreName, key: string) => run(store, 'readwrite', (objects) => objects.delete(key)).then(() => {}),
  all: <T>(store: StoreName) => run<T[]>(store, 'readonly', (objects) => objects.getAll() as IDBRequest<T[]>),
  keys: (store: StoreName) => run(store, 'readonly', (objects) => objects.getAllKeys()).then((keys) => keys.map(String)),
}

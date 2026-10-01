// Key-value storage abstraction.
//
// Implementations:
//   - IndexedDBKV  : production browser storage (durable, async, larger)
//   - MemoryKV     : in-memory, supports an artificial quota (tests/node)
//   - LocalStorageKV: tiny sync fallback (wrapped to the same async API)
//
// Every write may throw QuotaError. The queue layer reacts to it by purging
// RECONSTRUCTIBLE caches first and NEVER the sole copy of unuploaded ops.

export class QuotaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QuotaError'
    this.code = 'QUOTA_EXCEEDED'
  }
}

const DB_NAME = 'catalpa-autosave'
const STORE = 'kv'

export class MemoryKV {
  constructor({ quota = Infinity, initial = {} } = {}) {
    this.quota = quota
    this.map = new Map(Object.entries(initial))
    this.writeCount = 0
  }
  sizeOf(value) {
    return typeof value === 'string' ? value.length : JSON.stringify(value).length
  }
  async get(key) {
    return this.map.has(key) ? JSON.parse(this.map.get(key)) : undefined
  }
  async set(key, value) {
    const serialized = JSON.stringify(value)
    const otherBytes = [...this.map.entries()]
      .filter(([k]) => k !== key)
      .reduce((sum, [, v]) => sum + v.length, 0)
    if (otherBytes + serialized.length > this.quota) {
      throw new QuotaError(`quota exceeded writing ${key}`)
    }
    this.map.set(key, serialized)
    this.writeCount += 1
  }
  async delete(key) {
    this.map.delete(key)
  }
  async keys() {
    return [...this.map.keys()]
  }
  async bytesUsed() {
    return [...this.map.values()].reduce((s, v) => s + v.length, 0)
  }
}

export class LocalStorageKV {
  constructor(prefix = 'catalpa:') {
    this.prefix = prefix
  }
  async get(key) {
    const raw = globalThis.localStorage.getItem(this.prefix + key)
    return raw === null ? undefined : JSON.parse(raw)
  }
  async set(key, value) {
    try {
      globalThis.localStorage.setItem(this.prefix + key, JSON.stringify(value))
    } catch (err) {
      throw new QuotaError(err.message)
    }
  }
  async delete(key) {
    globalThis.localStorage.removeItem(this.prefix + key)
  }
  async keys() {
    const out = []
    for (let i = 0; i < globalThis.localStorage.length; i += 1) {
      const k = globalThis.localStorage.key(i)
      if (k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length))
    }
    return out
  }
  async bytesUsed() {
    let total = 0
    const keys = await this.keys()
    for (const k of keys) {
      total += (globalThis.localStorage.getItem(this.prefix + k) || '').length
    }
    return total
  }
}

export class IndexedDBKV {
  constructor(dbName = DB_NAME) {
    this.dbName = dbName
    this.dbPromise = null
  }
  open() {
    if (this.dbPromise) return this.dbPromise
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return this.dbPromise
  }
  tx(mode, fn) {
    return this.open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const request = fn(db.transaction(STORE, mode).objectStore(STORE))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => {
            const err = request.error
            if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
              reject(new QuotaError(err.message))
            } else {
              reject(err)
            }
          }
        }),
    )
  }
  async get(key) {
    return this.tx('readonly', (store) => store.get(key))
  }
  async set(key, value) {
    await this.tx('readwrite', (store) => {
      const req = store.put(value, key)
      return req
    }).catch((err) => {
      if (err.name === 'QuotaExceededError') throw new QuotaError(err.message)
      throw err
    })
  }
  async delete(key) {
    await this.tx('readwrite', (store) => store.delete(key))
  }
  async keys() {
    return this.tx('readonly', (store) => store.getAllKeys())
  }
  async bytesUsed() {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate()
      return est.usage || 0
    }
    return 0
  }
}

export function createDefaultKV() {
  if (typeof indexedDB !== 'undefined') return new IndexedDBKV()
  if (typeof globalThis.localStorage !== 'undefined') return new LocalStorageKV()
  return new MemoryKV()
}

// Cross-context event bus.
//
// In the browser it is backed by BroadcastChannel (with a storage-event
// fallback) so TWO TABS SHARING THE SAME QUEUE react to each other's writes.
// In tests/node it degrades to an in-process emitter.

export class MemoryBus {
  constructor() {
    this.listeners = new Map()
    this.sent = []
  }
  post(channel, message) {
    this.sent.push({ channel, message })
    const set = this.listeners.get(channel)
    if (set) for (const fn of set) fn(message)
  }
  on(channel, fn) {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set())
    this.listeners.get(channel).add(fn)
    return () => this.listeners.get(channel).delete(fn)
  }
}

export class BroadcastBus {
  constructor() {
    this.local = new MemoryBus()
    this.channel = null
    this.storageHandler = null
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('catalpa-autosave')
    }
  }
  post(channel, message) {
    this.local.post(channel, message)
    const envelope = { channel, message, at: Date.now() }
    if (this.channel) {
      this.channel.postMessage(envelope)
    } else if (typeof localStorage !== 'undefined') {
      // fallback for older browsers
      localStorage.setItem('catalpa:bus:' + channel, JSON.stringify(envelope))
    }
  }
  on(channel, fn) {
    const offLocal = this.local.on(channel, fn)
    let offStorage = () => {}
    if (this.channel) {
      const handler = (event) => {
        if (event.data && event.data.channel === channel) fn(event.data.message)
      }
      this.channel.addEventListener('message', handler)
      offStorage = () => this.channel.removeEventListener('message', handler)
    } else if (typeof addEventListener !== 'undefined') {
      const handler = (event) => {
        if (event.key === 'catalpa:bus:' + channel && event.newValue) {
          try {
            const envelope = JSON.parse(event.newValue)
            fn(envelope.message)
          } catch {
            /* ignore malformed */
          }
        }
      }
      addEventListener('storage', handler)
      offStorage = () => removeEventListener('storage', handler)
    }
    return () => {
      offLocal()
      offStorage()
    }
  }
}

export function createDefaultBus() {
  if (typeof window !== 'undefined') return new BroadcastBus()
  return new MemoryBus()
}

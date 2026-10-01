// Leader election so only one tab drives the network sync loop, while every
// tab reads/writes the same durable queue.
//
// Browser: Web Locks API (exclusive lock held for the tab's lifetime).
// Node/tests: an async flag with await so tests can appoint a leader.

export class MemoryLeader {
  constructor() {
    this.held = false
  }
  async acquire() {
    if (this.held) return false
    this.held = true
    return true
  }
  async release() {
    this.held = false
  }
}

export class WebLockLeader {
  constructor(name = 'catalpa-sync-leader') {
    this.name = name
    this.held = false
    this.lease = null
  }
  async acquire() {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      return false
    }
    let granted = false
    // The lock promise never resolves while held; race with a quick request.
    await new Promise((resolve) => {
      navigator.locks.request(this.name, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        granted = true
        this.held = true
        await new Promise((keep) => {
          this.release = () => {
            this.held = false
            keep()
          }
        })
      }).then(resolve, resolve)
    })
    return granted
  }
  async release() {
    if (this.release) this.release()
    this.held = false
  }
}

export function createDefaultLeader() {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return new WebLockLeader()
  }
  return new MemoryLeader()
}

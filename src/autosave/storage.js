import { CACHE_STORAGE_KEY, QUEUE_STORAGE_KEY, SCHEMA_VERSION } from './constants.js'

export class QuotaError extends Error {
  constructor(message = '浏览器存储配额不足') {
    super(message)
    this.name = 'QuotaError'
  }
}

function writeKey(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch (error) {
    if (error?.name === 'QuotaExceededError' || error?.code === 22) throw new QuotaError()
    throw error
  }
}

/**
 * Save critical queue. On quota exhaustion, delete only cache that can be
 * rebuilt from acknowledged server data; never remove unique queued edits.
 */
export function saveQueueState(state) {
  const serializable = {
    ...state,
    sessionRecovery: undefined,
    networkMode: undefined,
  }
  const payload = JSON.stringify({ ...serializable, schemaVersion: SCHEMA_VERSION })
  try {
    writeKey(QUEUE_STORAGE_KEY, payload)
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error
    clearRebuildableCache()
    writeKey(QUEUE_STORAGE_KEY, payload)
  }
}

export function loadQueueState() {
  const raw = localStorage.getItem(QUEUE_STORAGE_KEY)
  if (!raw) return null
  const parsed = JSON.parse(raw)
  return migrateState(parsed)
}

export function clearRebuildableCache() {
  // Remove all keys that can be reconstructed from acknowledged server data:
  // rendered preview cache, downloaded snapshots, derived indexes, etc.
  // The unique operation queue uses a different prefix and is never deleted.
  const keys = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key?.startsWith(`${CACHE_STORAGE_KEY}:`)) keys.push(key)
  }
  keys.forEach((key) => localStorage.removeItem(key))
  localStorage.removeItem(CACHE_STORAGE_KEY)
}

export function putCache(key, value) {
  try {
    writeKey(`${CACHE_STORAGE_KEY}:${key}`, JSON.stringify(value))
    return true
  } catch (error) {
    if (error instanceof QuotaError) return false
    throw error
  }
}

export function migrateState(state) {
  let next = { ...state }
  if (!next.schemaVersion || next.schemaVersion < 2) {
    // v1 stored only a full textarea string. Turn that into a normal queued
    // branch while retaining its content; do not silently overwrite cloud.
    if (typeof next.draftText === 'string') {
      next.needsFormatMigration = true
      next.migrationFromVersion = next.schemaVersion || 1
      next.legacyDraftText = next.draftText
    }
    next.schemaVersion = SCHEMA_VERSION
  }
  return normalizeState(next)
}

export function normalizeState(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    docId: state.docId,
    deviceId: state.deviceId,
    nextSeq: state.nextSeq ?? 1,
    baseVersion: state.baseVersion ?? 0,
    ancestorBlocks: state.ancestorBlocks ?? [],
    localBlocks: state.localBlocks ?? [],
    operations: state.operations ?? [],
    checkpoints: state.checkpoints ?? [],
    pendingCheckpoint: state.pendingCheckpoint ?? null,
    lastAckedAt: state.lastAckedAt ?? null,
    branchAudit: state.branchAudit ?? null,
    needsFormatMigration: state.needsFormatMigration ?? false,
    migrationFromVersion: state.migrationFromVersion ?? null,
    legacyDraftText: state.legacyDraftText ?? null,
  }
}

export async function acquireWebLock(name, callback, { timeout = 5000 } = {}) {
  if (!navigator.locks?.request) return callback()
  let timer
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等待本地锁超时: ${name}`)), timeout)
  })
  try {
    return await Promise.race([
      navigator.locks.request(name, async () => callback()),
      timeoutPromise,
    ])
  } finally {
    clearTimeout(timer)
  }
}

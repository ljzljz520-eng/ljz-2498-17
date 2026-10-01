// Stable per-browser device id used in op ids and branch labels.

const KEY = 'catalpa:deviceId'

export function getDeviceId(storage) {
  if (storage && storage.getDeviceId) return storage.getDeviceId()
  const id =
    `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  return id
}

export async function loadOrCreateDeviceId(kv, key = KEY) {
  const existing = await kv.get(key)
  if (existing && existing.id) return existing.id
  const id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  await kv.set(key, { id })
  return id
}

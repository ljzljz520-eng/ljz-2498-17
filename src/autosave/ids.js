export function hashString(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function opFingerprint(operation) {
  const { id, deviceId, seq, clientId, status, ...canonical } = operation
  return hashString(stableJson(canonical))
}

export function getDeviceId() {
  let id = localStorage.getItem('catalpa.deviceId')
  if (!id) {
    id = `dev-${(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)}`
    localStorage.setItem('catalpa.deviceId', id)
  }
  return id
}

// Thin HTTP client for the sync API.
//
// Important distinction encoded here:
//   - a 2xx response is a definite ack
//   - a network error / timeout is an UNKNOWN outcome, NOT a failure.
// The caller must reconcile (re-query / retry with the same op ids); it must
// never assume the commit failed and rebuild the draft.

function base() {
  // Vite dev proxies /api -> :3001; in prod same origin.
  return '/api'
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`)
    this.status = status
    this.code = body?.error?.code || 'HTTP_ERROR'
    this.body = body
  }
}

// Acceptance/demo hook: when non-null, sync requests carry an X-Fault header
// so the server can simulate timeout-after-commit / delay / offline.
export const faultControl = { header: null }

async function request(method, url, body, { signal, headers } = {}) {
  const extra = {}
  if (faultControl.header && url.endsWith('/sync')) {
    extra['x-fault'] = faultControl.header
  }
  let res
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...extra, ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    // Network failure / abort / timeout: outcome unknown.
    throw Object.assign(new Error(err.message || 'network error'), {
      code: 'NETWORK_UNKNOWN',
      cause: err,
    })
  }
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, payload)
  return payload
}

export const api = {
  getDoc(docId, opts) {
    return request('GET', `${base()}/docs/${encodeURIComponent(docId)}`, undefined, opts)
  },
  ensureDoc(docId, nodes, opts) {
    return request('POST', `${base()}/docs/${encodeURIComponent(docId)}`, { nodes }, opts)
  },
  sync(docId, payload, opts) {
    return request(
      'POST',
      `${base()}/docs/${encodeURIComponent(docId)}/sync`,
      payload,
      opts,
    )
  },
  listOps(docId, opts) {
    return request('GET', `${base()}/docs/${encodeURIComponent(docId)}/ops`, undefined, opts)
  },
  createCheckpoint(docId, name, opts) {
    return request(
      'POST',
      `${base()}/docs/${encodeURIComponent(docId)}/checkpoints`,
      { name },
      opts,
    )
  },
  listCheckpoints(docId, opts) {
    return request(
      'GET',
      `${base()}/docs/${encodeURIComponent(docId)}/checkpoints`,
      undefined,
      opts,
    )
  },
}

/** Fetch with a client-side timeout that leaves outcome UNKNOWN. */
export function fetchWithTimeout(promiseFactory, ms = 8000) {
  if (typeof AbortController === 'undefined') return promiseFactory()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return promiseFactory({ signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  )
}

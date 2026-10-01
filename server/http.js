// Minimal dependency-free HTTP layer around DocumentEngine.
//
// Fault injection (acceptance demos/tests) is controlled server-side via a
// header, never by touching real data:
//   X-Fault: timeout        -> socket destroyed mid-response (success may
//                              still have committed => "ack lost")
//   X-Fault: delay          -> slow response (client timeout)
//   X-Fault: offline        -> 503
//
// NOTE: when `timeout` fires the engine has ALREADY committed the ops before
// the socket is torn down. A retry therefore finds known opIds and returns
// their acks — proving we never rebuild the whole draft on a timeout.

import http from 'node:http'
import { URL } from 'node:url'
import { DocumentEngine } from './engine.js'
import { FileRepository } from './file-repo.js'

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(json)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 8 * 1024 * 1024) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

export function createServer({ repo, faultStore = null } = {}) {
  const engine = new DocumentEngine(repo)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url
    try {
      // ---- fault injection ----------------------------------------------
      const fault = req.headers['x-fault']
      if (fault === 'offline') {
        return send(res, 503, { error: { code: 'OFFLINE', message: 'simulated outage' } })
      }
      const maybeDelay = () =>
        new Promise((r) => {
          if (fault === 'delay') setTimeout(r, 5000)
          else r()
        })
      const destroyAfterCommit = () => {
        if (fault === 'timeout') {
          // Tear the socket down; the client sees a network error even though
          // the commit already happened.
          res.socket && res.socket.destroy()
          return true
        }
        return false
      }

      // ---- routes --------------------------------------------------------
      if (req.method === 'GET' && /^\/api\/docs\/[^/]+$/.test(pathname)) {
        const docId = decodeURIComponent(pathname.split('/').pop())
        const doc = await engine.getDoc(docId)
        if (!doc) return send(res, 404, { error: { code: 'NOT_FOUND' } })
        return send(res, 200, doc)
      }

      if (req.method === 'POST' && /^\/api\/docs\/[^/]+$/.test(pathname)) {
        const docId = decodeURIComponent(pathname.split('/').pop())
        const body = await readBody(req)
        const doc = await engine.createDoc(docId, body.nodes || [])
        return send(res, 200, doc)
      }

      if (req.method === 'POST' && /^\/api\/docs\/[^/]+\/sync$/.test(pathname)) {
        const docId = decodeURIComponent(pathname.split('/')[3])
        const body = await readBody(req)
        await maybeDelay()
        // Ensure doc exists even for an empty sync.
        await engine.createDoc(docId, [])
        const result = await engine.sync({
          docId,
          ops: body.ops || [],
          baseVersion: body.baseVersion || 0,
          mode: body.mode || 'nodes',
        })
        if (destroyAfterCommit()) return
        return send(res, 200, result)
      }

      if (req.method === 'GET' && /^\/api\/docs\/[^/]+\/ops$/.test(pathname)) {
        const docId = decodeURIComponent(pathname.split('/')[3])
        const doc = await engine.getDoc(docId)
        if (!doc) return send(res, 404, { error: { code: 'NOT_FOUND' } })
        return send(res, 200, {
          docId,
          version: doc.version,
          ops: doc.ops,
        })
      }

      if (req.method === 'POST' && /^\/api\/docs\/[^/]+\/checkpoints$/.test(pathname)) {
        const docId = decodeURIComponent(pathname.split('/')[3])
        const body = await readBody(req)
        const cp = await engine.createCheckpoint(docId, body.name || 'savepoint')
        return send(res, 200, cp)
      }

      if (req.method === 'GET' && /^\/api\/docs\/[^/]+\/checkpoints$/.test(pathname)) {
        const docId = decodeURIComponent(pathname.split('/')[3])
        const list = await engine.listCheckpoints(docId)
        return send(res, 200, { checkpoints: list })
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        return send(res, 200, { ok: true })
      }

      send(res, 404, { error: { code: 'NOT_FOUND', path: pathname } })
    } catch (err) {
      if (err.code === 'STALE_BASELINE') {
        return send(res, 409, {
          error: {
            code: 'STALE_BASELINE',
            message: 'client baseline is behind server; rebase required',
            ...err.payload,
          },
        })
      }
      if (err.code === 'OP_ID_CONFLICT') {
        return send(res, 409, {
          error: {
            code: 'OP_ID_CONFLICT',
            message: 'same operation id submitted with different content',
            ...err.payload,
          },
        })
      }
      if (err.code === 'NOT_FOUND') return send(res, 404, { error: { code: 'NOT_FOUND' } })
      send(res, err.status || 500, {
        error: { code: 'INTERNAL', message: err.message },
      })
    }
  })

  return { server, engine }
}

export async function startServer({ port, dataDir, repo: injectedRepo } = {}) {
  let repo = injectedRepo
  if (!repo) {
    if (process.env.DATABASE_URL) {
      try {
        const { PgRepository } = await import('./pg-repo.js')
        repo = await PgRepository.connect(process.env.DATABASE_URL)
        console.log('[catalpa-sync] using PostgreSQL repository')
      } catch (err) {
        console.warn(
          `[catalpa-sync] PostgreSQL unavailable (${err.message}); ` +
            `falling back to file repository`,
        )
        repo = new FileRepository(dataDir || './.data')
      }
    } else {
      repo = new FileRepository(dataDir || './.data')
    }
  }
  const { server } = createServer({ repo })
  await new Promise((resolve) => server.listen(port || 3001, resolve))
  return { server, repo, port: server.address().port }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3001)
  startServer({ port, dataDir: process.env.DATA_DIR || './.data' }).then(({ port: p }) => {
    console.log(`[catalpa-sync] listening on :${p}`)
  })
}

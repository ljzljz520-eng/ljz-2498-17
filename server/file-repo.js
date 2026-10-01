// JSON-file repository. Atomic writes (temp + rename). Used for local dev,
// tests and when PG is not configured. Implements the SAME interface as
// pg-repo so the engine is storage agnostic.

import { promises as fs } from 'node:fs'
import path from 'node:path'

export class FileRepository {
  constructor(dir) {
    this.dir = dir
    this.opsInTx = null
  }

  async _ensure() {
    await fs.mkdir(path.join(this.dir, 'docs'), { recursive: true })
    await fs.mkdir(path.join(this.dir, 'ops'), { recursive: true })
    await fs.mkdir(path.join(this.dir, 'checkpoints'), { recursive: true })
    await fs.mkdir(path.join(this.dir, 'snapshots'), { recursive: true })
  }

  _docPath(docId) {
    return path.join(this.dir, 'docs', `${docId}.json`)
  }
  _opsPath(docId) {
    return path.join(this.dir, 'ops', `${docId}.json`)
  }
  _snapshotDir(docId) {
    return path.join(this.dir, 'snapshots', docId)
  }
  _snapshotPath(docId, version) {
    return path.join(this._snapshotDir(docId), `${version}.json`)
  }

  async _readJson(file, fallback) {
    try {
      const raw = await fs.readFile(file, 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      if (err.code === 'ENOENT') return fallback
      throw err
    }
  }

  async _writeAtomic(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(value))
    await fs.rename(tmp, file)
  }

  async getDoc(docId) {
    return this._readJson(this._docPath(docId), null)
  }

  async putDoc(doc) {
    await this._ensure()
    await this._writeAtomic(this._docPath(doc.docId), doc)
  }

  async listOps(docId) {
    const ops = await this._readJson(this._opsPath(docId), [])
    return ops.sort((a, b) => a.version - b.version)
  }

  async appendOp(docId, op) {
    await this._ensure()
    const ops = await this._readJson(this._opsPath(docId), [])
    ops.push(op)
    await this._writeAtomic(this._opsPath(docId), ops)
  }

  async putSnapshot(snapshot) {
    await this._ensure()
    await this._writeAtomic(this._snapshotPath(snapshot.docId, snapshot.version), snapshot)
  }

  async getSnapshot(docId, version) {
    return this._readJson(this._snapshotPath(docId, version), null)
  }

  async getLatestSnapshotBefore(docId, version) {
    let entries = []
    try {
      entries = await fs.readdir(this._snapshotDir(docId))
    } catch {
      return null
    }
    const versions = entries
      .map((f) => Number(f.replace(/\.json$/, '')))
      .filter((v) => Number.isFinite(v) && v <= version)
      .sort((a, b) => b - a)
    if (!versions.length) return null
    return this._readJson(this._snapshotPath(docId, versions[0]), null)
  }

  async putCheckpoint(checkpoint) {
    await this._ensure()
    const index = await this._readJson(
      path.join(this.dir, 'checkpoints', `${checkpoint.docId}.json`),
      [],
    )
    const filtered = index.filter((c) => c.name !== checkpoint.name)
    filtered.push(checkpoint)
    await this._writeAtomic(
      path.join(this.dir, 'checkpoints', `${checkpoint.docId}.json`),
      filtered,
    )
  }

  async listCheckpoints(docId) {
    return this._readJson(path.join(this.dir, 'checkpoints', `${docId}.json`), [])
  }

  async getLatestCheckpoint(docId) {
    const all = await this.listCheckpoints(docId)
    if (!all.length) return null
    return all.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
  }
}

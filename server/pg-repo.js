// PostgreSQL repository. Holds the same three facts the requirement names:
//   - received operations (append-only op log)
//   - checkpoints (named save points)
//   - current document rows (version-guarded)
//
// The `pg` driver is loaded lazily so the project still runs/test without a
// database (FileRepository is used automatically). Set DATABASE_URL to use
// PostgreSQL in production.
//
// Conditional commits rely on a row lock (SELECT ... FOR UPDATE) inside a
// transaction, equivalent to the engine's in-process mutex.

export const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  doc_id          TEXT PRIMARY KEY,
  version         BIGINT NOT NULL DEFAULT 0,
  nodes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  baseline_nodes  JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash    TEXT NOT NULL DEFAULT '',
  format_version  INTEGER NOT NULL DEFAULT 3,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_ops (
  id          BIGSERIAL PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES docs(doc_id),
  op_id       TEXT NOT NULL,
  version     BIGINT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload     JSONB NOT NULL,
  received_at BIGINT NOT NULL,
  UNIQUE (doc_id, op_id)
);
CREATE INDEX IF NOT EXISTS doc_ops_doc_version ON doc_ops (doc_id, version);

CREATE TABLE IF NOT EXISTS doc_checkpoints (
  id           BIGSERIAL PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES docs(doc_id),
  name         TEXT NOT NULL,
  version      BIGINT NOT NULL,
  nodes        JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE (doc_id, name)
);

-- Exact per-version node snapshots so the TRUE common ancestor for a stale
-- baseline is reconstructable even after a folded auto-merge.
CREATE TABLE IF NOT EXISTS doc_snapshots (
  doc_id   TEXT NOT NULL REFERENCES docs(doc_id),
  version  BIGINT NOT NULL,
  nodes    JSONB NOT NULL,
  PRIMARY KEY (doc_id, version)
);
CREATE INDEX IF NOT EXISTS doc_snapshots_doc_ver ON doc_snapshots (doc_id, version);

-- Idempotent column additions for databases created by earlier versions.
ALTER TABLE docs ADD COLUMN IF NOT EXISTS baseline_nodes JSONB NOT NULL DEFAULT '[]'::jsonb;
`

export class PgRepository {
  constructor(pool) {
    this.pool = pool
  }

  static async connect(connectionString) {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString })
    const client = await pool.connect()
    try {
      await client.query(PG_SCHEMA)
    } finally {
      client.release()
    }
    return new PgRepository(pool)
  }

  async getDoc(docId) {
    const r = await this.pool.query(
      `SELECT doc_id AS "docId", version, nodes,
              baseline_nodes AS "baselineNodes",
              content_hash AS "contentHash",
              format_version AS "formatVersion", created_at AS "createdAt",
              updated_at AS "updatedAt"
       FROM docs WHERE doc_id = $1`,
      [docId],
    )
    return r.rows[0] || null
  }

  async putDoc(doc) {
    await this.pool.query(
      `INSERT INTO docs (doc_id, version, nodes, baseline_nodes, content_hash, format_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (doc_id) DO UPDATE SET
         version = EXCLUDED.version,
         nodes = EXCLUDED.nodes,
         baseline_nodes = EXCLUDED.baseline_nodes,
         content_hash = EXCLUDED.content_hash,
         format_version = EXCLUDED.format_version,
         updated_at = EXCLUDED.updated_at`,
      [
        doc.docId,
        doc.version,
        JSON.stringify(doc.nodes),
        JSON.stringify(doc.baselineNodes || []),
        doc.contentHash,
        doc.formatVersion,
        doc.createdAt,
        doc.updatedAt,
      ],
    )
  }

  async listOps(docId) {
    const r = await this.pool.query(
      `SELECT version, payload FROM doc_ops WHERE doc_id = $1 ORDER BY version`,
      [docId],
    )
    return r.rows.map((row) => ({ ...row.payload, version: Number(row.version) }))
  }

  async appendOp(docId, op) {
    await this.pool.query(
      `INSERT INTO doc_ops (doc_id, op_id, version, fingerprint, payload, received_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (doc_id, op_id) DO NOTHING`,
      [docId, op.opId, op.version, op.fingerprint, JSON.stringify(op), op.receivedAt],
    )
  }

  async putSnapshot(snapshot) {
    await this.pool.query(
      `INSERT INTO doc_snapshots (doc_id, version, nodes)
       VALUES ($1,$2,$3)
       ON CONFLICT (doc_id, version) DO UPDATE SET nodes = EXCLUDED.nodes`,
      [snapshot.docId, snapshot.version, JSON.stringify(snapshot.nodes)],
    )
  }

  async getSnapshot(docId, version) {
    const r = await this.pool.query(
      `SELECT version, nodes FROM doc_snapshots WHERE doc_id = $1 AND version = $2`,
      [docId, version],
    )
    return r.rows[0] || null
  }

  async getLatestSnapshotBefore(docId, version) {
    const r = await this.pool.query(
      `SELECT version, nodes FROM doc_snapshots
       WHERE doc_id = $1 AND version <= $2
       ORDER BY version DESC LIMIT 1`,
      [docId, version],
    )
    return r.rows[0] || null
  }

  async putCheckpoint(cp) {
    await this.pool.query(
      `INSERT INTO doc_checkpoints (doc_id, name, version, nodes, content_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (doc_id, name) DO UPDATE SET
         version = EXCLUDED.version,
         nodes = EXCLUDED.nodes,
         content_hash = EXCLUDED.content_hash,
         created_at = EXCLUDED.created_at`,
      [cp.docId, cp.name, cp.version, JSON.stringify(cp.nodes), cp.contentHash, cp.createdAt],
    )
  }

  async listCheckpoints(docId) {
    const r = await this.pool.query(
      `SELECT doc_id AS "docId", name, version, nodes, content_hash AS "contentHash",
              created_at AS "createdAt"
       FROM doc_checkpoints WHERE doc_id = $1 ORDER BY created_at`,
      [docId],
    )
    return r.rows
  }

  async getLatestCheckpoint(docId) {
    const r = await this.pool.query(
      `SELECT doc_id AS "docId", name, version, nodes, content_hash AS "contentHash",
              created_at AS "createdAt"
       FROM doc_checkpoints WHERE doc_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [docId],
    )
    return r.rows[0] || null
  }

  async close() {
    await this.pool.end()
  }
}

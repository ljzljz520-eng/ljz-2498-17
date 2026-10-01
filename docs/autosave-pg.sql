-- Auto-save operation log and named checkpoints for PostgreSQL 14+
CREATE TABLE documents (
  doc_id          uuid PRIMARY KEY,
  current_version bigint NOT NULL DEFAULT 1,
  current_content jsonb NOT NULL,
  format_version  integer NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doc_operations (
  doc_id        uuid NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  device_id     text NOT NULL,
  device_seq    bigint NOT NULL,
  operation_id  text GENERATED ALWAYS AS (device_id || ':' || device_seq) STORED,
  base_version  bigint NOT NULL,
  op_version    bigint NOT NULL,
  op_type       text NOT NULL CHECK (op_type IN ('insert_node','update_node','delete_node')),
  node_id       text NOT NULL,
  payload       jsonb NOT NULL,
  fingerprint   bytea NOT NULL,
  client_submit_id text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, device_id, device_seq),
  UNIQUE (doc_id, op_version)
);

CREATE TABLE doc_checkpoints (
  checkpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        uuid NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  name          text NOT NULL,
  version       bigint NOT NULL,
  snapshot      jsonb NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, name)
);

-- Idempotency / receipt-loss recovery and conflict diagnosis
CREATE INDEX idx_doc_operations_identity
  ON doc_operations(doc_id, device_id, device_seq, fingerprint);
CREATE INDEX idx_doc_operations_version ON doc_operations(doc_id, op_version DESC);

-- Server transaction: reject a stale expected version before applying operations.
-- BEGIN ISOLATION LEVEL REPEATABLE READ;
-- SELECT current_version, current_content
--   FROM documents WHERE doc_id = $1 FOR UPDATE;
-- IF $expected_version != current THEN
--   RAISE EXCEPTION USING SQLSTATE = 'PT412'; -- mapped to HTTP 412
-- END IF;
-- Each operation is keyed by (device_id, device_seq). Exact fingerprint means
-- idempotent replay; differing fingerprint is HTTP 409, never silent overwrite.
-- Name checkpoint only after operation commit and version advance.
-- COMMIT;

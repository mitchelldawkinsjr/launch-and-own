import { sha256Text } from '../imported/bytes.mjs';
import { ImportedEditError } from '../imported/errors.mjs';

// D1 limits the size of an individual row. This payload contains only ASCII
// file paths, metadata and base64 bytes, so it can be split at any offset.
const CHUNK_SIZE = 96_000;
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS assistant_visual_previews (
  expires_at INTEGER NOT NULL,
  approval_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (expires_at, approval_id, chunk_index)
) WITHOUT ROWID`;

export async function storeVisualPreview(db, { approvalId, expiresAt, now, snapshot }) {
  const payload = JSON.stringify(snapshot);
  const snapshotDigest = await sha256Text(payload);
  // Initialize on the first write so installed assistants can use their existing D1.
  const statements = [
    db.prepare(CREATE_TABLE),
    db.prepare('DELETE FROM assistant_visual_previews WHERE expires_at <= ?').bind(Math.floor(now / 1000))
  ];
  const insert = db.prepare(`INSERT INTO assistant_visual_previews
    (expires_at, approval_id, chunk_index, payload) VALUES (?, ?, ?, ?)`);
  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
    statements.push(insert.bind(expiresAt, approvalId, offset / CHUNK_SIZE, payload.slice(offset, offset + CHUNK_SIZE)));
  }
  await db.batch(statements);
  return snapshotDigest;
}

export async function readVisualPreview(db, { approvalId, exp, snapshotDigest }) {
  const { results } = await db.prepare(`SELECT payload FROM assistant_visual_previews
    WHERE expires_at = ? AND approval_id = ? ORDER BY chunk_index`).bind(exp, approvalId).all();
  if (!results.length) throw new ImportedEditError('expired');
  const payload = results.map(row => row.payload).join('');
  if (await sha256Text(payload) !== snapshotDigest) throw new ImportedEditError('approval_mismatch');
  return JSON.parse(payload);
}

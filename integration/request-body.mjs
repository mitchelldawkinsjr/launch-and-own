/** Validate the content type and cap streaming input before parsing. */
import {readBounded} from '../pipeline/bounded-body.mjs';

const utf8 = new TextDecoder('utf-8', {fatal: true});
export const MAX_MCP_BODY_BYTES = 64 * 1024;
export const MAX_BRIDGE_TICKET_BODY_BYTES = 4 * 1024;
export const MAX_OAUTH_BODY_BYTES = 8 * 1024;

export class BridgeRequestBodyError extends Error {
  constructor(status) {
    super('Bridge request body could not be read');
    this.status = status;
  }
}

async function readText(request, mediaType, limit) {
  const type = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== mediaType) throw new BridgeRequestBodyError(415);
  const length = request.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit)
    throw new BridgeRequestBodyError(413);
  let bytes;
  try { bytes = await readBounded(request.body, limit); }
  catch { throw new BridgeRequestBodyError(400); }
  if (bytes === null) throw new BridgeRequestBodyError(413);
  try { return utf8.decode(bytes); }
  catch { throw new BridgeRequestBodyError(400); }
}

export async function readBridgeJson(request, limit) {
  const text = await readText(request, 'application/json', limit);
  try { return JSON.parse(text); }
  catch { throw new BridgeRequestBodyError(400); }
}

export function hasRepeatedFields(fields) {
  const names = new Set();
  for (const name of fields.keys()) {
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

export async function readOAuthForm(request) {
  const text = await readText(request, 'application/x-www-form-urlencoded', MAX_OAUTH_BODY_BYTES);
  const fields = new URLSearchParams(text);
  if (hasRepeatedFields(fields)) throw new BridgeRequestBodyError(400);
  return fields;
}

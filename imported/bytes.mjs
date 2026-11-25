const encoder = new TextEncoder();

export function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeUtf8(text) {
  return encoder.encode(text);
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Bytes(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Text(text) {
  return sha256Bytes(encoder.encode(text));
}

export async function gitBlobSha(bytes) {
  const prefix = encoder.encode(`blob ${bytes.byteLength}\0`);
  const packed = new Uint8Array(prefix.byteLength + bytes.byteLength);
  packed.set(prefix, 0);
  packed.set(bytes, prefix.byteLength);
  return hex(await crypto.subtle.digest('SHA-1', packed));
}

export function base64Encode(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64Decode(text) {
  const binary = atob(String(text).replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function sameBytes(left, right) {
  if (left === right) return true;
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
  return true;
}

export function jcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('jcs number');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + jcs(value[key])).join(',') + '}';
  }
  throw new TypeError('jcs value');
}

export function stableJson(value) {
  return jcs(value);
}

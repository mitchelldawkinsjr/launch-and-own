import { crc32, inflateRawSync } from 'node:zlib';

export const MAX_ZIP_BYTES = 6 * 1024 * 1024;
export const MAX_SITE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SITE_FILES = 128;

export class WebsiteZipError extends Error {}

const types = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8', rsc: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', xml: 'application/xml', rss: 'application/rss+xml', atom: 'application/atom+xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf', wasm: 'application/wasm', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
  wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', vtt: 'text/vtt; charset=utf-8'
};
export function contentType(path) {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
  return Object.hasOwn(types, extension) ? types[extension] : null;
}

const namePattern = /^[a-z0-9_][a-z0-9 _.,+@()[\]~-]{0,119}$/i;
const specialName = /^(?:functions|_worker\.js|_headers|_redirects|_routes\.json|wrangler\.(?:jsonc?|toml))$/i;
const safeName = name => namePattern.test(name) && !/[. ]$/.test(name) && !specialName.test(name)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
export const isSitePath = path => typeof path === 'string' && path.length <= 240
  && path.split('/').every(safeName) && !!contentType(path);

const malformed = () => new WebsiteZipError('This ZIP is invalid or corrupted. Export and upload it again.');
const unsupported = () => new WebsiteZipError('Use a standard, unencrypted ZIP containing regular files and folders.');
const unsafeName = () => new WebsiteZipError('The ZIP contains an unsupported file name or a hosting configuration file. Upload the static build output.');
const expandedLimit = () => new WebsiteZipError('The extracted website must be 8 MiB or less, with each file at most 2 MiB.');
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function utf8Contents(bytes) {
  try { return utf8Decoder.decode(bytes); } catch { return null; }
}

export {readBounded} from '../pipeline/bounded-body.mjs';

function zipDirectory(view) {
  // The end record is followed only by its optional, length-prefixed comment.
  for (let end = view.byteLength - 22, min = Math.max(0, end - 65535); end >= min; end--) {
    if (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== view.byteLength) continue;
    const count = view.getUint16(end + 10, true);
    const length = view.getUint32(end + 12, true);
    const start = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
        || count !== view.getUint16(end + 8, true) || count === 0xffff) throw unsupported();
    if (start + length !== end || count === 0) throw malformed();
    if (count > MAX_SITE_FILES * 4) throw new WebsiteZipError('This ZIP has too many entries. Upload up to 128 website files.');
    return { start, end, count };
  }
  throw malformed();
}

function directoryEntries(bytes, view, { start, end, count }) {
  const entries = [];
  let position = start;
  let expanded = 0;
  while (entries.length < count) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw malformed();
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const crc = view.getUint32(position + 16, true);
    const packed = view.getUint32(position + 20, true);
    const size = view.getUint32(position + 24, true);
    const nameSize = view.getUint16(position + 28, true);
    const nameEnd = position + 46 + nameSize;
    const next = nameEnd + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    const attrs = view.getUint32(position + 38, true);
    const mode = (attrs >>> 16) & 0xf000;
    const local = view.getUint32(position + 42, true);
    if (!nameSize || next > end) throw malformed();
    // UTF-8, deflate options, and a trailing data descriptor are the supported flags.
    if (flags & ~0x080e || (method !== 0 && method !== 8) || view.getUint16(position + 34, true)
        || view.getUint16(position + 6, true) >= 45 || (mode && mode !== 0x8000 && mode !== 0x4000)) throw unsupported();
    const rawName = bytes.subarray(position + 46, nameEnd);
    const name = utf8Contents(rawName);
    if (!name || name.length > 241) throw unsafeName();
    const folder = name.endsWith('/');
    const path = folder ? name.slice(0, -1) : name;
    const parts = path.split('/');
    const appleMetadata = parts[0] === '__MACOSX';
    if (!parts.every(part => safeName(part) || part === '.DS_Store'
        || (appleMetadata && part.startsWith('._') && safeName(part.slice(2))))) throw unsafeName();
    if (((mode === 0x4000 || (attrs & 0x10)) && !folder) || (folder && (size !== 0 || crc !== 0))
        || (method === 0 && packed !== size)) throw malformed();
    const ignored = appleMetadata || (!folder && parts.at(-1) === '.DS_Store');
    if (parts.slice(0, -1).includes('.DS_Store') || (folder && parts.at(-1) === '.DS_Store')) throw unsafeName();
    expanded += size;
    if (expanded > MAX_SITE_BYTES || size > MAX_FILE_BYTES) throw expandedLimit();
    entries.push({ flags, method, crc, packed, size, rawName, local, path, folder, ignored });
    position = next;
  }
  if (position !== end) throw malformed();
  return entries;
}

function checkLocalEntries(bytes, view, entries, directoryStart) {
  // The local records and payloads must be disjoint and must agree with the directory.
  const ordered = [...entries].sort((a, b) => a.local - b.local);
  let previousEnd = 0;
  for (const [index, entry] of ordered.entries()) {
    const { local, method, flags, rawName, packed, size, crc } = entry;
    const next = ordered[index + 1]?.local ?? directoryStart;
    if (local !== previousEnd || next > directoryStart || local + 30 > next
        || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 4, true) >= 45
        || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method
        || view.getUint16(local + 26, true) !== rawName.length) throw malformed();
    const nameAt = local + 30;
    const dataAt = nameAt + rawName.length + view.getUint16(local + 28, true);
    const dataEnd = dataAt + packed;
    if (dataEnd > next || !rawName.every((byte, i) => bytes[nameAt + i] === byte)) throw malformed();
    if (flags & 8) {
      const descriptor = next - dataEnd === 16 && view.getUint32(dataEnd, true) === 0x08074b50 ? dataEnd + 4 : dataEnd;
      if (next - descriptor !== 12 || view.getUint32(descriptor, true) !== crc
          || view.getUint32(descriptor + 4, true) !== packed || view.getUint32(descriptor + 8, true) !== size) throw malformed();
    } else if (dataEnd !== next || view.getUint32(local + 14, true) !== crc
        || view.getUint32(local + 18, true) !== packed || view.getUint32(local + 22, true) !== size) throw malformed();
    entry.compressed = bytes.subarray(dataAt, dataEnd);
    previousEnd = next;
  }
}

function checkPaths(entries) {
  const explicit = new Set();
  const names = new Map();
  for (const { path, folder } of entries) {
    const key = path.toLowerCase();
    if (explicit.has(key)) throw new WebsiteZipError('The ZIP contains duplicate file or folder names.');
    explicit.add(key);
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join('/');
      const directory = i < parts.length || folder;
      const identity = spelling.toLowerCase();
      const existing = names.get(identity);
      if (existing && (existing.spelling !== spelling || existing.directory !== directory)) {
        throw new WebsiteZipError('The ZIP contains conflicting file or folder names.');
      }
      names.set(identity, { spelling, directory });
    }
  }
}

function extract(entry) {
  let bytes = entry.compressed;
  if (entry.method === 8) {
    let inflated;
    try {
      inflated = inflateRawSync(bytes, { maxOutputLength: Math.max(entry.size, 1), info: true });
    } catch { throw malformed(); }
    // Require exactly one complete compressed stream and consume its full payload.
    if (inflated.engine.bytesWritten !== bytes.byteLength) throw malformed();
    bytes = inflated.buffer;
  }
  if (bytes.byteLength !== entry.size || crc32(bytes) !== entry.crc) throw malformed();
  return bytes;
}

export async function extractWebsiteZip(bytes) {
  if (!bytes.byteLength || bytes.byteLength > MAX_ZIP_BYTES) {
    throw new WebsiteZipError('Choose a ZIP file that is 6 MiB or less.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = zipDirectory(view);
  const entries = directoryEntries(bytes, view, directory);
  checkLocalEntries(bytes, view, entries, directory.start);
  checkPaths(entries);
  const included = entries.filter(entry => !entry.ignored && !entry.folder);
  if (included.length > MAX_SITE_FILES) throw new WebsiteZipError('Upload up to 128 website files.');
  let prefix = '';
  if (!included.some(entry => entry.path === 'index.html')) {
    const firstFolder = included[0]?.path.split('/')[0];
    if (!firstFolder || !included.every(entry => entry.path.startsWith(firstFolder + '/'))
        || !included.some(entry => entry.path === firstFolder + '/index.html')) {
      throw new WebsiteZipError('Include index.html at the top of the ZIP or inside a single build folder.');
    }
    prefix = firstFolder + '/';
  }
  const files = [];
  for (const entry of included) {
    const path = entry.path.slice(prefix.length);
    if (!isSitePath(path)) throw new WebsiteZipError('Upload the built website with static files such as HTML, CSS, JavaScript, images, and fonts.');
    const contents = extract(entry);
    if (contentType(path).startsWith('text/html')) {
      const text = utf8Contents(contents);
      if (text === null || (path === 'index.html' && !text.trim())) {
        throw new WebsiteZipError('Website HTML must be UTF-8 and the homepage must have content.');
      }
    }
    files.push({ path, bytes: contents });
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

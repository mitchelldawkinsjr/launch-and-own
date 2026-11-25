import { encodeUtf8, gitBlobSha, jcs, sha256Bytes, sha256Text, utf8 } from './bytes.mjs';
import { ImportedEditError } from './errors.mjs';
import { isColor, isRefusedPath, maskCss, MAX_FILE_BYTES, missingLocalPaths, resolvesInsideSite, structuralPath, styleInnerRanges } from './intelligence.mjs';
import { artifactDigest } from './preview.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set(['text', 'link', 'business_info', 'css_color']);
const MAX_OUTPUT = 16000;
const MAX_EDITS = 10;

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => own.includes(key));
}

function plain(value, max, allowMarkup = false) {
  const blocked = allowMarkup ? /[\u0000-\u001F\u007F`{}\\]/ : /[\u0000-\u001F\u007F<>`{}\\]/;
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !blocked.test(value);
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function occurrences(text, needle) {
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function colorCount(text, color) {
  const hex = color.startsWith('#');
  let count = 0;
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(color, from);
    if (at < 0) break;
    const before = text[at - 1] || '';
    const after = text[at + color.length] || '';
    const beforeOk = hex ? !/[0-9a-fA-F#]/i.test(before) : !/[A-Za-z0-9_-]/.test(before);
    const afterOk = hex ? !/[0-9a-fA-F]/i.test(after) : !/[A-Za-z0-9_-]/.test(after);
    if (beforeOk && afterOk) count += 1;
    from = at + Math.max(color.length, 1);
  }
  return count;
}

function safeLink(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 300) return false;
  if (/[\s<>"'`]/.test(value) || /^(?:javascript|data|vbscript|file):/i.test(value) || value.startsWith('//')) return false;
  if (value === '/') return true;
  return /^(?:https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+|mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|tel:\+?[0-9().-]{7,20}|\/?[A-Za-z0-9][A-Za-z0-9._/-]*|#[A-Za-z0-9_-]+)$/.test(value);
}

function safeReplacementLink(value) {
  return safeLink(value) && !/^http:/i.test(value);
}

export function parseModelOutput(raw) {
  let text = raw;
  if (typeof raw !== 'string') {
    try { text = JSON.stringify(raw); } catch { throw new ImportedEditError('invalid_output'); }
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_OUTPUT) throw new ImportedEditError('invalid_output');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new ImportedEditError('invalid_output'); }
  if (!exactKeys(parsed, ['v', 'requestId', 'repositoryId', 'baseCommitSha', 'summary', 'edits'])
      || parsed.v !== 1 || typeof parsed.requestId !== 'string' || !UUID.test(parsed.requestId)
      || !Number.isSafeInteger(parsed.repositoryId) || parsed.repositoryId < 1
      || typeof parsed.baseCommitSha !== 'string' || !SHA.test(parsed.baseCommitSha)
      || typeof parsed.summary !== 'string' || parsed.summary.length < 1 || parsed.summary.length > 200
      || /[\u0000-\u001F\u007F]/.test(parsed.summary)) {
    throw new ImportedEditError('invalid_output');
  }
  if (!Array.isArray(parsed.edits)) throw new ImportedEditError('invalid_output');
  if (parsed.edits.length > MAX_EDITS) throw new ImportedEditError('limit_exceeded');
  const edits = parsed.edits.map(edit => {
    if (!exactKeys(edit, ['kind', 'path', 'expectedBlobSha', 'find', 'replace']) || !KINDS.has(edit.kind)) throw new ImportedEditError('invalid_output');
    if (typeof edit.path !== 'string' || !edit.path.startsWith('public/')) throw new ImportedEditError('invalid_output');
    const path = edit.path.slice('public/'.length);
    if (!structuralPath(path) || typeof edit.find !== 'string' || typeof edit.replace !== 'string') throw new ImportedEditError('invalid_output');
    if (typeof edit.expectedBlobSha !== 'string' || !SHA.test(edit.expectedBlobSha)) throw new ImportedEditError('invalid_output');
    if (edit.find.length > 2000 || edit.replace.length > 2000) throw new ImportedEditError('limit_exceeded');
    return { kind: edit.kind, path, old: edit.find, new: edit.replace, expectedBlobSha: edit.expectedBlobSha.toLowerCase() };
  });
  return {
    v: 1,
    requestId: parsed.requestId.toLowerCase(),
    repositoryId: parsed.repositoryId,
    baseCommitSha: parsed.baseCommitSha.toLowerCase(),
    summary: parsed.summary,
    edits
  };
}

function tagEnd(html, from) {
  let quote = '';
  for (let index = from; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

// Visible text only. Script, style, comments, and attributes are not text nodes.
function textSpans(html) {
  const spans = [];
  let index = 0;
  let start = 0;
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      if (index > start) spans.push([start, index]);
      const end = html.indexOf('-->', index + 4);
      if (end < 0) return null;
      index = end + 3;
      start = index;
      continue;
    }
    if (html[index] !== '<') {
      index += 1;
      continue;
    }
    if (index > start) spans.push([start, index]);
    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const end = html.indexOf('>', index + 2);
      if (end < 0) return null;
      index = end + 1;
      start = index;
      continue;
    }
    const tag = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)/.exec(html.slice(index));
    const end = tag ? tagEnd(html, index + 1) : -1;
    if (!tag || end < 0) return null;
    const name = tag[2].toLowerCase();
    const selfClose = /\/\s*>$/.test(html.slice(index, end + 1));
    index = end + 1;
    start = index;
    if (!tag[1] && !selfClose && (name === 'script' || name === 'style' || name === 'template' || name === 'textarea')) {
      const close = new RegExp(`</\\s*${name}\\s*>`, 'i').exec(html.slice(index));
      if (!close) return null;
      index += close.index + close[0].length;
      start = index;
    }
  }
  if (start < html.length) spans.push([start, html.length]);
  return spans;
}

function insideTextNode(html, at, length) {
  const spans = textSpans(html);
  return Boolean(spans && spans.some(([start, end]) => at >= start && at + length <= end));
}

function declarationSpan(text, color, path) {
  const html = /\.html?$/i.test(path || '');
  const ranges = html ? styleInnerRanges(text) : [[0, text.length]];
  if (!ranges) return null;
  let found = null;
  let count = 0;
  for (const [start, end] of ranges) {
    const masked = maskCss(text.slice(start, end));
    if (masked === null) return null;
    const pattern = /(?:^|[{;])\s*(--[\w-]+)\s*:\s*([^;}]+)/g;
    for (const match of masked.matchAll(pattern)) {
      const raw = match[2];
      if (raw.trim() !== color) continue;
      count += 1;
      found = start + match.index + match[0].length - raw.length + (raw.length - raw.trimStart().length);
    }
  }
  return count === 1 ? found : null;
}

function anchorHref(html, url) {
  let index = 0;
  let count = 0;
  let owner = '';
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    if (html[index] !== '<') {
      index += 1;
      continue;
    }
    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const end = html.indexOf('>', index + 2);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    const tag = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)/.exec(html.slice(index));
    const end = tag ? tagEnd(html, index + 1) : -1;
    if (!tag || end < 0) return null;
    const href = tag[1] ? null : /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html.slice(index, end + 1));
    if (href && (href[1] ?? href[2]) === url) {
      count += 1;
      owner = tag[2].toLowerCase();
    }
    index = end + 1;
  }
  return count === 1 ? owner : null;
}

function locate(text, edit) {
  if (edit.kind === 'css_color') {
    if (!isColor(edit.old) || !isColor(edit.new)) throw new ImportedEditError('context_not_allowed');
    const at = declarationSpan(text, edit.old, edit.path);
    if (typeof at !== 'number') {
      const count = colorCount(text, edit.old);
      throw new ImportedEditError(count > 1 ? 'ambiguous_match' : count === 0 ? 'no_match' : 'context_not_allowed');
    }
    return { at, length: edit.old.length, replacement: edit.new };
  }
  if (edit.kind === 'link') {
    if (!safeLink(edit.old) || !safeReplacementLink(edit.new) || !resolvesInsideSite(edit.path, edit.new)) {
      throw new ImportedEditError('context_not_allowed');
    }
    const owner = anchorHref(text, edit.old);
    const copies = occurrences(text, edit.old);
    if (copies !== 1) throw new ImportedEditError(copies > 1 ? 'ambiguous_match' : 'no_match');
    if (owner !== 'a') throw new ImportedEditError('context_not_allowed');
    return { at: text.indexOf(edit.old), length: edit.old.length, replacement: edit.new };
  }
  const limit = edit.kind === 'business_info' ? 300 : 500;
  if (!plain(edit.old, limit) || !plain(edit.new, limit, true)) throw new ImportedEditError('context_not_allowed');
  const copies = occurrences(text, edit.old);
  if (copies !== 1) throw new ImportedEditError(copies > 1 ? 'ambiguous_match' : 'no_match');
  const at = text.indexOf(edit.old);
  if (!insideTextNode(text, at, edit.old.length)) throw new ImportedEditError('context_not_allowed');
  return { at, length: edit.old.length, replacement: escapeHtml(edit.new) };
}

function applyEdits(text, edits) {
  const ranges = edits.map(edit => ({ ...locate(text, edit), kind: edit.kind }));
  ranges.sort((left, right) => left.at - right.at);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].at <= ranges[index - 1].at + ranges[index - 1].length) throw new ImportedEditError('overlapping_edits');
  }
  let next = text;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    next = next.slice(0, range.at) + range.replacement + next.slice(range.at + range.length);
  }
  return { text: next, ranges };
}

export async function validateEdits({ baseCommitSha, files, inspection, proposal, repositoryId }) {
  if (typeof baseCommitSha !== 'string' || !SHA.test(baseCommitSha)) throw new ImportedEditError('stale_base');
  if (!proposal || proposal.v !== 1 || proposal.repositoryId !== repositoryId || proposal.baseCommitSha !== baseCommitSha.toLowerCase()) {
    throw new ImportedEditError('stale_base');
  }
  if (!Array.isArray(files) || !inspection || !Array.isArray(inspection.files)) throw new ImportedEditError('invalid-site-files');
  const allow = new Map(inspection.files.map(file => [
    file.path.startsWith('public/') ? file.path.slice('public/'.length) : file.path,
    file
  ]));
  const current = new Map(files.map(file => [file.path, file.bytes]));
  const texts = new Map();
  for (const file of files) {
    if (!(file.bytes instanceof Uint8Array)) throw new ImportedEditError('invalid-site-files');
    texts.set(file.path, utf8(file.bytes));
  }
  const seen = new Set();
  const byPath = new Map();
  for (const edit of proposal.edits) {
    if (seen.has(edit.path + '\0' + edit.kind + '\0' + edit.old)) throw new ImportedEditError('overlapping_edits');
    seen.add(edit.path + '\0' + edit.kind + '\0' + edit.old);
    if (isRefusedPath(edit.path) || /\.(?:js|mjs|cjs)$/i.test(edit.path)) throw new ImportedEditError('kind_not_allowed');
    const allowed = allow.get(edit.path);
    if (!allowed || !Array.isArray(allowed.editable) || !allowed.editable.includes(edit.kind)) throw new ImportedEditError('kind_not_allowed');
    const bytes = current.get(edit.path);
    if (typeof texts.get(edit.path) !== 'string' || !(bytes instanceof Uint8Array)) throw new ImportedEditError('kind_not_allowed');
    if (await gitBlobSha(bytes) !== edit.expectedBlobSha) throw new ImportedEditError('stale_base');
    if (!byPath.has(edit.path)) byPath.set(edit.path, []);
    byPath.get(edit.path).push(edit);
  }
  if (byPath.size > 5) throw new ImportedEditError('limit_exceeded');
  const spans = [];
  for (const edit of proposal.edits) spans.push({ edit, at: locate(texts.get(edit.path), edit).at });
  const beforeMissing = new Set(missingLocalPaths(files));
  for (const [path, edits] of byPath) {
    const applied = applyEdits(texts.get(path), edits);
    if (/\.html?$/i.test(path)) {
      if (textSpans(applied.text) === null) throw new ImportedEditError('context_not_allowed');
      const inners = styleInnerRanges(applied.text);
      let shift = 0;
      for (const range of applied.ranges) {
        const at = range.at + shift;
        if ((range.kind === 'text' || range.kind === 'business_info')
            && !insideTextNode(applied.text, at, range.replacement.length)) {
          throw new ImportedEditError('context_not_allowed');
        }
        if (range.kind === 'css_color' && (!inners || !inners.some(([start, end]) => at >= start && at + range.replacement.length <= end))) {
          throw new ImportedEditError('context_not_allowed');
        }
        shift += range.replacement.length - range.length;
      }
    }
    if (/\.css$/i.test(path) && maskCss(applied.text) === null) throw new ImportedEditError('context_not_allowed');
    const next = applied.text;
    const bytes = encodeUtf8(next);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ImportedEditError('limit_exceeded');
    texts.set(path, next);
    current.set(path, bytes);
  }
  const nextFiles = files.map(file => ({ path: file.path, bytes: current.get(file.path) }));
  const edited = new Set(proposal.edits.map(edit => edit.path));
  for (let index = 0; index < files.length; index += 1) {
    if (!edited.has(files[index].path) && files[index].bytes !== nextFiles[index].bytes) throw new ImportedEditError('unrelated_change');
  }
  if (missingLocalPaths(nextFiles).some(path => !beforeMissing.has(path))) throw new ImportedEditError('missing_local_dependency');
  const changed = [];
  for (let index = 0; index < files.length; index++) {
    if (files[index].bytes === nextFiles[index].bytes) continue;
    changed.push({
      path: 'public/' + files[index].path,
      beforeBlobSha: await gitBlobSha(files[index].bytes),
      afterSha256: await sha256Bytes(nextFiles[index].bytes)
    });
  }
  changed.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  spans.sort((left, right) => left.edit.path < right.edit.path ? -1 : left.edit.path > right.edit.path ? 1 : left.at - right.at);
  const canonical = {
    v: 1,
    requestId: proposal.requestId,
    repositoryId: proposal.repositoryId,
    baseCommitSha: baseCommitSha.toLowerCase(),
    summary: proposal.summary,
    edits: spans.map(({ edit }) => ({
      kind: edit.kind, path: 'public/' + edit.path, expectedBlobSha: edit.expectedBlobSha, find: edit.old, replace: edit.new
    }))
  };
  return {
    baseCommitSha: canonical.baseCommitSha,
    edits: proposal.edits.map(edit => ({ ...edit })),
    files: nextFiles,
    changed,
    proposalDigest: await sha256Text(jcs(canonical)),
    artifactDigest: await artifactDigest(nextFiles)
  };
}

export function unrelatedFilesIdentical(before, after, changedPaths) {
  const changed = new Set(changedPaths);
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  for (let index = 0; index < before.length; index++) {
    if (before[index].path !== after[index].path) return false;
    if (!changed.has(before[index].path) && before[index].bytes !== after[index].bytes) return false;
  }
  return true;
}

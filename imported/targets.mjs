// Inventory-backed edit targets for the visual editor: only spans the edit engine can apply (contract §2).
import { utf8 } from './bytes.mjs';
import { ImportedEditError } from './errors.mjs';
import { isColor, maskCss, styleInnerRanges } from './intelligence.mjs';

const KIND_LABEL = { text: 'Visible text', link: 'Link', business_info: 'Email or phone', css_color: 'Color' };
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE = /^\+?[0-9().\s-]{7,20}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,120}$/;

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

function stripPublic(path) {
  return path.startsWith('public/') ? path.slice('public/'.length) : path;
}

function businessInfoKind(find) {
  const trimmed = find.trim();
  if (!trimmed || trimmed.length > 300) return null;
  if (EMAIL.test(trimmed) || (PHONE.test(trimmed) && /\d/.test(trimmed))) return 'business_info';
  return null;
}

function textKind(find) {
  if (find.length < 1 || find.length > 500) return null;
  if (/[\u0000-\u001F\u007F<>`{}\\]/.test(find)) return null;
  return 'text';
}

function anchorLinks(html) {
  const links = [];
  let index = 0;
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
    if (href && tag[2].toLowerCase() === 'a') links.push(href[1] ?? href[2]);
    index = end + 1;
  }
  return links;
}

function cssColorFinds(text, path) {
  const html = /\.html?$/i.test(path || '');
  const ranges = html ? styleInnerRanges(text) : [[0, text.length]];
  if (!ranges) return [];
  const found = [];
  for (const [start, end] of ranges) {
    const masked = maskCss(text.slice(start, end));
    if (masked === null) return [];
    const pattern = /(?:^|[{;])\s*(--[\w-]+)\s*:\s*([^;}]+)/g;
    for (const match of masked.matchAll(pattern)) {
      const color = match[2].trim();
      if (!isColor(color)) continue;
      found.push({ name: match[1], color });
    }
  }
  return found;
}

function targetId(relative, kind, find) {
  const slug = relative.replace(/[^\w.-]+/g, '_').slice(0, 40);
  const hash = [...find].slice(0, 40).reduce((acc, c) => acc + c.charCodeAt(0).toString(36), '');
  return (slug + '_' + kind + '_' + hash).replace(/[^a-z0-9_-]/gi, '_').toLowerCase().slice(0, 120);
}

function pushTarget(targets, seen, row) {
  if (seen.has(row.id)) return;
  seen.add(row.id);
  targets.push(row);
}

/**
 * @returns {{ id, kind, kindLabel, relativePath, find, label }[]}
 */
export function listEditTargets(files, inspection) {
  if (!Array.isArray(files) || !inspection?.files) throw new ImportedEditError('invalid-site-files');
  const allow = new Map(inspection.files.map(file => [stripPublic(file.path), file]));
  const texts = new Map(files.map(file => [file.path, file.text ?? (file.bytes instanceof Uint8Array ? utf8(file.bytes) : null)]));
  const targets = [];
  const seen = new Set();

  for (const file of inspection.files) {
    const relative = stripPublic(file.path);
    if (!allow.get(relative)?.editable?.length) continue;
    const editable = new Set(file.editable);
    const text = texts.get(relative) ?? texts.get(file.path);
    if (typeof text !== 'string') continue;

    if (editable.has('text') || editable.has('business_info') || editable.has('link')) {
      const spans = textSpans(text);
      if (spans === null) continue;
      for (const [start, end] of spans) {
        const find = text.slice(start, end);
        if (!find.trim()) continue;
        if (occurrences(text, find) !== 1 || !insideTextNode(text, start, find.length)) continue;
        const bi = businessInfoKind(find);
        if (bi && editable.has(bi)) {
          pushTarget(targets, seen, {
            id: targetId(relative, bi, find),
            kind: bi,
            kindLabel: KIND_LABEL[bi],
            relativePath: relative,
            find,
            label: find.length > 80 ? find.slice(0, 77) + '…' : find
          });
        }
        const tk = textKind(find);
        if (tk && editable.has(tk)) {
          pushTarget(targets, seen, {
            id: targetId(relative, tk, find),
            kind: tk,
            kindLabel: KIND_LABEL[tk],
            relativePath: relative,
            find,
            label: find.length > 80 ? find.slice(0, 77) + '…' : find
          });
        }
      }
    }

    if (editable.has('link')) {
      const links = anchorLinks(text);
      if (links === null) continue;
      for (const find of links) {
        if (!find || find.length > 300 || occurrences(text, find) !== 1) continue;
        pushTarget(targets, seen, {
          id: targetId(relative, 'link', find),
          kind: 'link',
          kindLabel: KIND_LABEL.link,
          relativePath: relative,
          find,
          label: find.length > 64 ? find.slice(0, 61) + '…' : find
        });
      }
    }

    if (editable.has('css_color')) {
      for (const row of cssColorFinds(text, relative)) {
        const find = row.color;
        if (occurrences(text, find) !== 1) continue;
        const label = row.name + ': ' + find;
        pushTarget(targets, seen, {
          id: targetId(relative, 'css_color', find),
          kind: 'css_color',
          kindLabel: KIND_LABEL.css_color,
          relativePath: relative,
          find,
          label
        });
      }
    }
  }

  targets.sort((left, right) => left.relativePath < right.relativePath ? -1
    : left.relativePath > right.relativePath ? 1 : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : left.find < right.find ? -1 : left.find > right.find ? 1 : 0);
  return targets;
}

export function pickEditTarget(targets, raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 120 || !ID.test(raw)) return null;
  return targets.find(target => target.id === raw) ?? null;
}

export function editablePages(inspection) {
  const pages = [];
  for (const file of inspection.files ?? []) {
    if (!file.editable?.length) continue;
    const relative = stripPublic(file.path);
    if (/\.html?$/i.test(relative)) pages.push(relative);
  }
  return [...new Set(pages)].sort();
}

export function defaultEditorPage(pages) {
  if (!Array.isArray(pages) || !pages.length) return 'index.html';
  return pages.includes('index.html') ? 'index.html' : pages[0];
}
import { isSitePath } from '../onboarding/website-zip.mjs';
import { ImportedEditError } from './errors.mjs';
import { gitBlobSha, utf8 } from './bytes.mjs';

// Same byte ceilings as onboarding/website-zip.mjs. Importability uses that
// importer's path rules so a tree the ZIP rejects stays importable: false.
export const MAX_FILES = 128;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SITE_BYTES = 8 * 1024 * 1024;

const SOURCE_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'tsconfig.json', 'jsconfig.json', 'requirements.txt', 'pyproject.toml', 'gemfile', 'go.mod',
  'cargo.toml', 'composer.json', 'dockerfile', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc',
  '_worker.js', '_headers', '_redirects', '_routes.json', 'jenkinsfile'
]);
const SOURCE_DIRS = new Set(['node_modules', '.github', 'functions', '.git']);
const PART = /^[A-Za-z0-9._@()[\]~+-][A-Za-z0-9 ._+@()[\]~-]{0,119}$/;

export function structuralPath(path) {
  if (typeof path !== 'string' || !path || path.length > 240) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every(part => part && part !== '.' && part !== '..' && PART.test(part) && !/[. ]$/.test(part));
}

export function isRefusedPath(path) {
  const base = path.split('/').pop().toLowerCase();
  if (SOURCE_FILES.has(base)) return true;
  if (/^(?:vite|webpack|rollup|astro|svelte|remix)\.config\./i.test(base)) return true;
  if (/^(?:next|nuxt)\.config\./i.test(base)) return true;
  if (path.split('/').some(part => SOURCE_DIRS.has(part))) return true;
  if (/\.(?:jsx|tsx|vue|svelte)$/i.test(path)) return true;
  if (/\.ts$/i.test(path) && !path.endsWith('.d.ts')) return true;
  if (/(?:^|\/)\.env(?:\.|$)/i.test(path)) return true;
  return false;
}

function extension(path) {
  return /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() || '';
}

function isMinified(text) {
  if (!text || text.length < 400) return false;
  const lines = text.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return longest >= 400 && lines.length <= 3;
}

function isCompiledAsset(path, text) {
  const ext = extension(path);
  if (!['js', 'mjs', 'css'].includes(ext)) return false;
  if (/\.min\.(?:js|mjs|css)$/i.test(path)) return true;
  if (/[.-][a-f0-9]{8,}(?:\.|$)/i.test(path.split('/').pop())) return true;
  return (ext === 'js' || ext === 'mjs') && isMinified(text);
}

function prepare(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw new ImportedEditError('invalid-site-files');
  const seen = new Set();
  let total = 0;
  const prepared = [];
  for (const file of files) {
    if (!file || !structuralPath(file.path) || !(file.bytes instanceof Uint8Array)) throw new ImportedEditError('invalid-site-files');
    if (seen.has(file.path)) throw new ImportedEditError('duplicate-path');
    seen.add(file.path);
    if (file.bytes.byteLength > MAX_FILE_BYTES) throw new ImportedEditError('file-too-large');
    total += file.bytes.byteLength;
    if (total > MAX_SITE_BYTES) throw new ImportedEditError('site-too-large');
    const ext = extension(file.path);
    const text = ['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md'].includes(ext) ? utf8(file.bytes) : null;
    prepared.push({ path: file.path, bytes: file.bytes, size: file.bytes.byteLength, text });
  }
  return prepared;
}

export function resolvesInsideSite(fromPath, value) {
  if (/^(?:https:|mailto:|tel:)/i.test(value)) return true;
  if (value.startsWith('#') || value.startsWith('?') || value === '/') return true;
  return resolveLocal(fromPath, value) !== null;
}

function resolveLocal(fromPath, raw) {
  const clean = String(raw).split('#')[0].split('?')[0];
  if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null;
  const base = clean.startsWith('/') ? [] : (fromPath.includes('/') ? fromPath.split('/').slice(0, -1) : []);
  const out = [];
  for (const part of base.concat(clean.split('/'))) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  const path = out.join('/');
  return structuralPath(path) ? path : null;
}

// shortcut: quoted src and href only, upgrade if the corpus shows unquoted local references.
function missingLocalAssets(prepared) {
  const present = new Set(prepared.map(file => file.path));
  const missing = new Set();
  for (const file of prepared) {
    if (file.text === null) continue;
    const ext = extension(file.path);
    if (ext === 'html' || ext === 'htm') {
      const pattern = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
      for (const match of file.text.matchAll(pattern)) {
        const target = resolveLocal(file.path, match[1] ?? match[2]);
        if (target && !localTargetPresent(present, target)) missing.add(target);
      }
    }
    for (const raw of cssReferences(file)) {
      const target = resolveLocal(file.path, raw);
      if (target && !localTargetPresent(present, target)) missing.add(target);
    }
  }
  return [...missing].sort();
}

// Same destinations the ZIP preview serves: the file itself, a directory index, or an .html twin.
function localTargetPresent(present, target) {
  return present.has(target) || present.has(target + '/index.html') || present.has(target + '.html');
}

function hasBareSpecifier(text) {
  const pattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1] || match[2];
    if (specifier && !specifier.startsWith('.') && !specifier.startsWith('/')) return true;
  }
  return false;
}

function isBareModule(file) {
  const ext = extension(file.path);
  return ['js', 'mjs'].includes(ext) && typeof file.text === 'string'
    && !isCompiledAsset(file.path, file.text) && hasBareSpecifier(file.text);
}

function cssReferences(file) {
  if (extension(file.path) !== 'css' || typeof file.text !== 'string') return [];
  const masked = file.text.replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length));
  const found = [];
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of file.text.matchAll(pattern)) {
    if (masked.slice(match.index, match.index + match[0].length) !== match[0]) continue;
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    if (raw) found.push(raw);
  }
  return found;
}

function classify(prepared) {
  if (prepared.some(file => isRefusedPath(file.path))) return 'source_project';
  const index = prepared.find(file => file.path === 'index.html');
  if (!index || index.text === null || !index.text.trim()) return 'unsupported';
  if (prepared.some(isBareModule)) return 'source_project';
  if (prepared.some(file => isCompiledAsset(file.path, file.text))) return 'compiled_bundle';
  const pages = prepared.filter(file => extension(file.path) === 'html' || extension(file.path) === 'htm');
  return pages.length >= 2 ? 'static_multipage' : 'static';
}

function fileType(path) {
  const ext = extension(path);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext)) return 'image';
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
  return 'other';
}

const NAMED_COLORS = new Set('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor'.split(' '));
const COLOR_FNS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch']);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const PERCENT = /^[+-]?(?:\d+\.?\d*|\.\d+)%$/;
const HUE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|rad|grad|turn)?$/i;

function isNone(token) {
  return token.toLowerCase() === 'none';
}

function isNumberOrPercent(token) {
  return isNone(token) || NUMBER.test(token) || PERCENT.test(token);
}

function isHue(token) {
  return isNone(token) || HUE.test(token);
}

function isPercent(token) {
  return isNone(token) || PERCENT.test(token);
}

function colorTokens(body) {
  const tokens = [];
  const pattern = /[+-]?(?:\d+\.?\d*|\.\d+)(?:%|deg|rad|grad|turn)?|[a-z]+|,|\//gi;
  let end = 0;
  for (const match of body.matchAll(pattern)) {
    if (/\S/.test(body.slice(end, match.index))) return null;
    tokens.push(match[0]);
    end = match.index + match[0].length;
  }
  return /\S/.test(body.slice(end)) ? null : tokens;
}

function splitBy(tokens, separator) {
  const groups = [];
  let current = [];
  for (const token of tokens) {
    if (token === separator) {
      if (current.length !== 1) return null;
      groups.push(current[0]);
      current = [];
    } else current.push(token);
  }
  if (current.length !== 1) return null;
  groups.push(current[0]);
  return groups;
}

function sameChannel(tokens) {
  if (tokens.length !== 3) return false;
  const concrete = tokens.filter(token => !isNone(token));
  const percent = concrete.some(token => token.endsWith('%'));
  const number = concrete.some(token => !token.endsWith('%'));
  if (percent && number) return false;
  return tokens.every(token => isNone(token) || (percent ? PERCENT.test(token) : NUMBER.test(token)));
}

function commaColor(name, groups) {
  const alpha = groups.length === 3 || (groups.length === 4 && isNumberOrPercent(groups[3]));
  if (!alpha) return false;
  if (name === 'rgb' || name === 'rgba') return sameChannel(groups.slice(0, 3));
  if (name === 'hsl' || name === 'hsla') return isHue(groups[0]) && isPercent(groups[1]) && isPercent(groups[2]);
  return false;
}

function spaceColor(name, main) {
  if (name === 'rgb' || name === 'rgba') return sameChannel(main);
  if (name === 'hsl' || name === 'hsla' || name === 'hwb') return main.length === 3 && isHue(main[0]) && isPercent(main[1]) && isPercent(main[2]);
  if (name === 'lab' || name === 'oklab') return main.length === 3 && main.every(isNumberOrPercent);
  if (name === 'lch' || name === 'oklch') return main.length === 3 && isNumberOrPercent(main[0]) && isNumberOrPercent(main[1]) && isHue(main[2]);
  return false;
}

// shortcut: one color token only. color(), color-mix(), and relative colors stay refused until an edit needs them.
function functionalColor(value) {
  const open = value.indexOf('(');
  if (open < 3 || !value.endsWith(')') || /\s/.test(value.slice(0, open))) return false;
  const name = value.slice(0, open).toLowerCase();
  if (!COLOR_FNS.has(name)) return false;
  const tokens = colorTokens(value.slice(open + 1, -1));
  if (!tokens || tokens.length === 0) return false;
  if (tokens.includes(',')) {
    const groups = splitBy(tokens, ',');
    return Boolean(groups && !groups.includes('/') && commaColor(name, groups));
  }
  const slash = tokens.indexOf('/');
  if (slash !== tokens.lastIndexOf('/') || (slash >= 0 && slash !== tokens.length - 2)) return false;
  const alpha = slash < 0 ? null : tokens[slash + 1];
  return (alpha === null || isNumberOrPercent(alpha)) && spaceColor(name, slash < 0 ? tokens : tokens.slice(0, slash));
}

export function isColor(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 160) return false;
  if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return true;
  if (NAMED_COLORS.has(value.toLowerCase())) return true;
  return functionalColor(value);
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

export function maskCss(css) {
  let out = '';
  for (let index = 0; index < css.length; index += 1) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      if (end < 0) return null;
      out += ' '.repeat(end + 2 - index);
      index = end + 1;
      continue;
    }
    const quote = css[index] === '"' || css[index] === "'" ? css[index] : '';
    if (quote) {
      const start = index;
      index += 1;
      while (index < css.length && css[index] !== quote) index += css[index] === '\\' ? 2 : 1;
      if (index >= css.length) return null;
      out += ' '.repeat(index - start + 1);
      continue;
    }
    out += css[index];
  }
  return out;
}

// Inner CSS of each style element. Script, template, and textarea contents are not CSS.
export function styleInnerRanges(html) {
  const ranges = [];
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
    const name = tag[2].toLowerCase();
    const selfClose = /\/\s*>$/.test(html.slice(index, end + 1));
    index = end + 1;
    if (tag[1] || selfClose) continue;
    if (name === 'script' || name === 'template' || name === 'textarea') {
      const close = new RegExp(`</\\s*${name}\\s*>`, 'i').exec(html.slice(index));
      if (!close) return null;
      index += close.index + close[0].length;
      continue;
    }
    if (name === 'style') {
      const close = /<\/\s*style\s*>/i.exec(html.slice(index));
      if (!close) return null;
      ranges.push([index, index + close.index]);
      index += close.index + close[0].length;
    }
  }
  return ranges;
}

function cssDeclaresCustomColor(css) {
  const masked = maskCss(css);
  if (masked === null) return false;
  for (const match of masked.matchAll(/(?:^|[{;])\s*--[\w-]+\s*:\s*([^;}]+)/g)) {
    if (isColor(match[1].trim())) return true;
  }
  return false;
}

function hasStyleCustomColor(html) {
  const ranges = styleInnerRanges(html);
  if (!ranges) return false;
  return ranges.some(([start, end]) => cssDeclaresCustomColor(html.slice(start, end)));
}

function editKinds(file, classification) {
  if (classification !== 'static' && classification !== 'static_multipage') return [];
  const ext = extension(file.path);
  if (ext === 'css' && file.text !== null && !isMinified(file.text) && cssDeclaresCustomColor(file.text)) return ['css_color'];
  if ((ext === 'html' || ext === 'htm') && file.text !== null && !isMinified(file.text)) {
    const kinds = ['text', 'link', 'business_info'];
    if (hasStyleCustomColor(file.text)) kinds.push('css_color');
    return kinds;
  }
  return [];
}

function readOnlyReason(file, classification, kinds) {
  if (kinds.length) return null;
  if (!isSitePath(file.path)) return 'unsupported_file_type';
  if (isRefusedPath(file.path)) return 'config_file';
  if (isBareModule(file)) return 'bare_import';
  if (isCompiledAsset(file.path, file.text) || classification === 'compiled_bundle') return 'minified_js_bundle';
  if (classification === 'source_project') return 'source_project';
  return null;
}

function hasExternalReference(prepared) {
  for (const file of prepared) {
    if (file.text === null) continue;
    const refs = [];
    const ext = extension(file.path);
    if (ext === 'html' || ext === 'htm') {
      for (const match of file.text.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) refs.push(match[1] ?? match[2]);
    }
    refs.push(...cssReferences(file));
    if (refs.some(raw => /^(?:https?:)?\/\//i.test(String(raw)))) return true;
  }
  return false;
}

function siteReasons(prepared, classification, missing) {
  const reasons = new Set();
  const index = prepared.find(file => file.path === 'index.html');
  if (index?.text?.trim()) reasons.add('has_index_html');
  if (classification === 'source_project') reasons.add('source_project');
  if (prepared.some(isBareModule)) reasons.add('bare_import');
  if (classification === 'compiled_bundle') reasons.add('minified_js_bundle');
  if (prepared.some(file => !isSitePath(file.path))) reasons.add('unsupported_file_type');
  if (missing.length) reasons.add('missing_local_dependency');
  if (hasExternalReference(prepared)) reasons.add('external_dependency');
  return [...reasons].sort();
}

export function missingLocalPaths(files) {
  return missingLocalAssets(prepare(files));
}

export async function inspectSite(files) {
  const prepared = prepare(files);
  const classification = classify(prepared);
  const inventory = [];
  for (const file of prepared) {
    const editable = editKinds(file, classification);
    inventory.push({
      path: 'public/' + file.path,
      blobSha: await gitBlobSha(file.bytes),
      bytes: file.size,
      type: fileType(file.path),
      editable,
      readOnlyReason: readOnlyReason(file, classification, editable)
    });
  }
  inventory.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const missing = missingLocalAssets(prepared);
  const importable = prepared.every(file => isSitePath(file.path));
  return {
    v: 1,
    root: 'public/',
    classification,
    importable,
    serveReady: importable && classification !== 'source_project' && classification !== 'unsupported' && missing.length === 0,
    reasons: siteReasons(prepared, classification, missing),
    files: inventory
  };
}

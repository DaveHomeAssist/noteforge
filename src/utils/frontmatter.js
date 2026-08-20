// Lossless leading-frontmatter boundary and the only adapter allowed to load
// `yaml`. Recognition stays synchronous and tiny for the editor; standards-
// compliant parsing/editing is lazy so the dependency never joins the app shell.

import { splitFrontmatterSource } from './frontmatter-boundary.js';
export { splitFrontmatterSource } from './frontmatter-boundary.js';

export const MAX_FRONTMATTER_BYTES = 262_144;
export const FRONTMATTER_MIGRATION_VERSION = 1;

const KEY_RE = /^[^\r\n]{1,128}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FrontmatterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FrontmatterError';
    this.code = code;
    Object.assign(this, details);
  }
}

let yamlModule;
const loadYaml = () => (yamlModule ||= import('yaml'));

function diagnostic(error, lineCounter = null) {
  const position = Number.isFinite(error?.pos?.[0]) && lineCounter
    ? lineCounter.linePos(error.pos[0])
    : null;
  return Object.freeze({
    code: error?.code || 'invalid_yaml',
    message: error?.message || String(error),
    line: position?.line || null,
    column: position?.col || null,
  });
}

/** Parse a recognized leading document without interpreting custom tags. */
export async function parseFrontmatter(markdown) {
  const split = splitFrontmatterSource(markdown);
  if (!split.hasFrontmatter) {
    return Object.freeze({ status: 'none', split, properties: new Map(), document: null, diagnostics: [] });
  }
  if (split.raw.length > MAX_FRONTMATTER_BYTES) {
    return Object.freeze({
      status: 'invalid', split, properties: new Map(), document: null,
      diagnostics: [Object.freeze({ code: 'frontmatter_too_large', message: `Frontmatter exceeds ${MAX_FRONTMATTER_BYTES.toLocaleString()} bytes.`, line: 1, column: 1 })],
    });
  }

  const { LineCounter, isMap, parseDocument } = await loadYaml();
  const lineCounter = new LineCounter();
  let document;
  try {
    document = parseDocument(split.yaml, {
      version: '1.2',
      schema: 'core',
      customTags: [],
      merge: false,
      resolveKnownTags: false,
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      keepSourceTokens: true,
      lineCounter,
      logLevel: 'silent',
    });
  } catch (error) {
    return Object.freeze({ status: 'invalid', split, properties: new Map(), document: null, diagnostics: [diagnostic(error, lineCounter)] });
  }
  const errors = [...(document.errors || []), ...(document.warnings || []).filter((warning) => warning?.code === 'TAG_RESOLVE_FAILED')];
  if (errors.length || (document.contents !== null && !isMap(document.contents))) {
    const diagnostics = errors.length
      ? errors.map((error) => diagnostic(error, lineCounter))
      : [Object.freeze({ code: 'mapping_required', message: 'Frontmatter must be a YAML mapping of property names to values.', line: 1, column: 1 })];
    return Object.freeze({ status: 'invalid', split, properties: new Map(), document, diagnostics });
  }

  try {
    // Map output prevents prototype-shaped keys from mutating object prototypes;
    // the alias cap bounds YAML expansion work.
    const value = document.toJS({ mapAsMap: true, maxAliasCount: 20 });
    const properties = value instanceof Map ? value : new Map();
    return Object.freeze({ status: 'valid', split, properties, document, diagnostics: [] });
  } catch (error) {
    return Object.freeze({ status: 'invalid', split, properties: new Map(), document, diagnostics: [diagnostic(error, lineCounter)] });
  }
}

export function isSafeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isIsoDate(value) {
  if (!DATE_RE.test(String(value))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** Validate/coerce one UI-supported property type. */
export function normalizePropertyValue(type, raw) {
  switch (type) {
    case 'text':
    case 'select':
      return String(raw ?? '');
    case 'number': {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new FrontmatterError('invalid_number', 'Enter a finite number.');
      return value;
    }
    case 'boolean':
      if (raw === true || raw === 'true') return true;
      if (raw === false || raw === 'false') return false;
      throw new FrontmatterError('invalid_boolean', 'Choose true or false.');
    case 'date':
      if (!isIsoDate(raw)) throw new FrontmatterError('invalid_date', 'Enter a real date in YYYY-MM-DD form.');
      return String(raw);
    case 'url':
      if (!isSafeHttpUrl(raw)) throw new FrontmatterError('unsafe_url', 'Only HTTP and HTTPS URLs are allowed.');
      return String(raw);
    case 'multi-select':
      return [...new Set((Array.isArray(raw) ? raw : String(raw ?? '').split(','))
        .map((value) => String(value).trim()).filter(Boolean))];
    default:
      throw new FrontmatterError('unsupported_type', `Unsupported property type: ${type}.`);
  }
}

export function inferPropertyType(value, key = '') {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return 'multi-select';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'string' && isIsoDate(value)) return 'date';
  if (typeof value === 'string' && isSafeHttpUrl(value)) return 'url';
  if (typeof value === 'string') return key === 'status' || key === 'type' ? 'select' : 'text';
  return 'unsupported';
}

function composeSource(parsed, yamlText) {
  const { split } = parsed;
  const newline = split.newline || '\n';
  const normalized = String(yamlText).replace(/\r?\n/g, newline).replace(new RegExp(`${newline.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`), '');
  return `---${newline}${normalized}${normalized ? newline : ''}${split.closing || '---'}${split.separator || newline}${split.body}`;
}

/** Mutate one YAML node while leaving every body byte untouched. */
export async function setFrontmatterProperty(markdown, key, value, { type = null } = {}) {
  const property = String(key ?? '').trim();
  if (!KEY_RE.test(property)) throw new FrontmatterError('invalid_key', 'Property names must be 1–128 characters on one line.');
  const parsed = await parseFrontmatter(markdown);
  if (parsed.status === 'invalid') throw new FrontmatterError('invalid_yaml', parsed.diagnostics[0]?.message || 'Frontmatter is invalid.', { diagnostics: parsed.diagnostics });
  const normalized = type ? normalizePropertyValue(type, value) : value;
  if (property === 'noteforge_id' && parsed.status === 'valid' && parsed.properties.has(property) && parsed.properties.get(property) !== normalized) {
    throw new FrontmatterError('immutable_property', 'noteforge_id is immutable in the property editor.');
  }

  const { Document } = await loadYaml();
  const document = parsed.status === 'valid' ? parsed.document : new Document(new Map(), null, { version: '1.2' });
  document.set(property, normalized);
  const base = parsed.status === 'valid'
    ? parsed
    : { ...parsed, split: { ...parsed.split, closing: '---', separator: parsed.split.newline, body: parsed.split.body } };
  return composeSource(base, document.toString({ lineWidth: 0, directives: false }));
}

export async function removeFrontmatterProperty(markdown, key) {
  const property = String(key ?? '').trim();
  if (property === 'noteforge_id') throw new FrontmatterError('immutable_property', 'noteforge_id is immutable in the property editor.');
  const parsed = await parseFrontmatter(markdown);
  if (parsed.status !== 'valid') {
    if (parsed.status === 'none') return String(markdown ?? '');
    throw new FrontmatterError('invalid_yaml', parsed.diagnostics[0]?.message || 'Frontmatter is invalid.', { diagnostics: parsed.diagnostics });
  }
  parsed.document.delete(property);
  return composeSource(parsed, parsed.document.toString({ lineWidth: 0, directives: false }));
}

export function aliasesFromProperties(properties) {
  const value = properties instanceof Map ? properties.get('aliases') : null;
  if (value === undefined) return { valid: true, present: false, aliases: [] };
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { valid: false, present: true, aliases: [] };
  }
  return { valid: true, present: true, aliases: value };
}

/** Flat, normalized derived values used only by the search index. */
export function propertySearchIndex(properties) {
  const index = new Map();
  let visited = 0;
  const flatten = (value, depth = 0) => {
    if (++visited > 1_000 || depth > 5) return [];
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.flatMap((entry) => flatten(entry, depth + 1));
    if (value instanceof Map) return [...value.values()].flatMap((entry) => flatten(entry, depth + 1));
    if (typeof value === 'object') return Object.values(value).flatMap((entry) => flatten(entry, depth + 1));
    return [String(value).normalize('NFKC').trim().toLowerCase()].filter(Boolean);
  };
  for (const [key, value] of properties instanceof Map ? properties : []) {
    index.set(String(key).normalize('NFKC').trim().toLowerCase(), flatten(value));
  }
  return index;
}

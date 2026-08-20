// The Note model. Intentionally a plain data holder — link/backlink graph is
// *derived* by the Database from note content rather than stored on each note,
// which keeps the graph consistent no matter how notes are edited or imported.

import { uid, normalizeTitle } from '../utils/helpers.js';
import { extractWikilinks } from '../utils/wikilinks.js';

// Only CSS gradient functions with no url()/markup — a gradient value is
// assigned to style.backgroundImage, so `url(https://evil/x.gif)` would be a
// tracking beacon and must be rejected.
const SAFE_GRADIENT_RE = /^(?:repeating-)?(?:linear|radial|conic)-gradient\([^;<>]*\)$/i;
// Image values become an <img src>; restrict to web + image data URLs.
const SAFE_IMAGE_RE = /^(?:https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);)/i;

function isSafeGradient(v) {
  return SAFE_GRADIENT_RE.test(v) && !/url\s*\(/i.test(v);
}

/**
 * Normalize a banner value to a clean, storable shape or null. A banner is note
 * metadata (a Notion-style cover) — NOT markdown content — so it lives on the
 * note and never touches note.content / the block model. The value is validated
 * against a strict allowlist so imported/legacy banners can't inject CSS url()
 * beacons or unexpected URL schemes.
 * @returns {null | { type:'gradient'|'image', value:string, position:number }}
 */
export function normalizeBanner(banner) {
  if (!banner || typeof banner !== 'object') return null;
  const value = typeof banner.value === 'string' ? banner.value.trim() : '';
  if (!value) return null;
  let type = null;
  if (banner.type === 'gradient' && isSafeGradient(value)) type = 'gradient';
  else if (banner.type === 'image' && SAFE_IMAGE_RE.test(value)) type = 'image';
  if (!type) return null;
  let position = Number(banner.position);
  if (!Number.isFinite(position)) position = 50;
  position = Math.max(0, Math.min(100, position));
  return { type, value, position };
}

/** Preserve first-seen spelling while removing blanks, title duplicates, and
 * case/Unicode-equivalent aliases. */
export function normalizeAliases(aliases, title = '') {
  const titleKey = normalizeTitle(title);
  const seen = new Set(titleKey ? [titleKey] : []);
  const result = [];
  for (const value of Array.isArray(aliases) ? aliases : []) {
    if (typeof value !== 'string') continue;
    const stored = value.trim();
    const key = normalizeTitle(stored);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(stored);
  }
  return result;
}

export class Note {
  constructor({
    id = uid(),
    title = 'Untitled',
    content = '',
    tags = [],
    banner = null,
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
    deletedAt = null,
    pinned = false,
    parentId = null,
    aliases = [],
    archivedAt = null,
    ...extra
  } = {}) {
    // Preserve additive/unknown JSON metadata so a portable backup can restore
    // fields introduced by a compatible producer without silently discarding
    // them. Known fields below always override colliding input keys.
    this._extra = { ...extra };
    this.id = id;
    this.title = title;
    this.content = content;
    this.tags = Array.isArray(tags) ? [...tags] : [];
    this.banner = normalizeBanner(banner);
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    // Soft-delete marker: null = live, ISO string = when it was trashed.
    this.deletedAt = typeof deletedAt === 'string' ? deletedAt : null;
    // Pinned notes float to the top of the sidebar.
    this.pinned = !!pinned;
    // Parent note id for the outline tree (null = top level).
    this.parentId = typeof parentId === 'string' && parentId !== id ? parentId : null;
    // Alternate human-readable link targets. Canonical title always wins when
    // resolving; collisions across notes are diagnosed by Database.
    this.aliases = normalizeAliases(aliases, title);
    // Archive is a separate lifecycle state from Trash.
    this.archivedAt = typeof archivedAt === 'string' ? archivedAt : null;
  }

  static fromJSON(data) {
    // Tolerant of partial/legacy data; ignores any stored links/backlinks
    // since those are recomputed from content.
    return new Note(data);
  }

  toJSON() {
    return {
      ...this._extra,
      id: this.id,
      title: this.title,
      content: this.content,
      tags: this.tags,
      banner: this.banner,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deletedAt: this.deletedAt,
      pinned: this.pinned,
      parentId: this.parentId,
      aliases: [...this.aliases],
      archivedAt: this.archivedAt,
    };
  }

  /** True while the note is in the Trash (soft-deleted). */
  get isTrashed() {
    return this.deletedAt != null;
  }

  get isArchived() {
    return this.archivedAt != null;
  }

  /** Move to Trash. Preserves createdAt/updatedAt so restore is lossless. */
  markTrashed(when = new Date().toISOString()) {
    this.deletedAt = when;
  }

  /** Restore from Trash. */
  restore() {
    this.deletedAt = null;
  }

  markArchived(when = new Date().toISOString()) {
    this.archivedAt = when;
    this.touch();
  }

  unarchive() {
    this.archivedAt = null;
    this.touch();
  }

  /** Pin/unpin. Does NOT touch updatedAt, so pinning doesn't reorder by recency. */
  setPinned(pinned) {
    this.pinned = !!pinned;
  }

  setAliases(aliases) {
    this.aliases = normalizeAliases(aliases, this.title);
    this.touch();
    return this.aliases;
  }

  /** Set (or clear) the banner. Pass null to remove. Returns the normalized value. */
  setBanner(banner) {
    this.banner = normalizeBanner(banner);
    this.touch();
    return this.banner;
  }

  /** Wikilink targets referenced by this note's content (distinct, in order). */
  outgoingLinks() {
    return extractWikilinks(this.content);
  }

  touch() {
    this.updatedAt = new Date().toISOString();
  }

  update({ title, content, tags, aliases }) {
    if (title !== undefined) {
      this.title = title;
      this.aliases = normalizeAliases(aliases === undefined ? this.aliases : aliases, title);
    } else if (aliases !== undefined) {
      this.aliases = normalizeAliases(aliases, this.title);
    }
    if (content !== undefined) this.content = content;
    if (tags !== undefined) this.tags = Array.isArray(tags) ? [...tags] : this.tags;
    this.touch();
  }

  addTag(tag) {
    const t = String(tag).trim();
    if (t && !this.tags.includes(t)) {
      this.tags.push(t);
      this.touch();
    }
  }

  removeTag(tag) {
    const before = this.tags.length;
    this.tags = this.tags.filter((t) => t !== tag);
    if (this.tags.length !== before) this.touch();
  }

  matchesTitle(title) {
    return normalizeTitle(this.title) === normalizeTitle(title);
  }
}

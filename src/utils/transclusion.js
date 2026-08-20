import { escapeAttr, escapeHtml } from './helpers.js';
import { blockToMarkdown, resolveBlockId } from './block-links.js';
import { renderMarkdown } from './markdown.js';

const placeholder = (kind, message) => `<aside class="transclusion transclusion--${kind}" role="note" aria-label="${escapeAttr(message)}" contenteditable="false"><span>${escapeHtml(message)}</span></aside>`;

/** A synchronous renderer registered only after the deferred Phase 5 chunk loads. */
export function createTransclusionRenderer() {
  return (token, context) => {
    const id = token.fragment.slice(1);
    if (!context?.resolveNote) return placeholder('unavailable', `Embedded block ${token.target}#^${id}`);
    const note = context.resolveNote(token.target);
    if (!note) return placeholder('missing', `Embedded block not found: ${token.target}#^${id}`);
    const resolved = resolveBlockId(note.content, id);
    if (resolved.status !== 'resolved') {
      const reason = resolved.status === 'duplicate' ? 'Duplicate block ID' : 'Embedded block not found';
      return placeholder(resolved.status, `${reason}: ${note.title}#^${id}`);
    }
    const reference = `${note.id}#^${id}`;
    if (context.chain.includes(reference)) return placeholder('cycle', `Transclusion cycle stopped at ${note.title}#^${id}`);
    if (context.depth >= context.maxDepth) return placeholder('depth', `Transclusion depth limit reached at ${note.title}#^${id}`);
    if (context.budget.used >= context.budget.max) return placeholder('budget', 'Transclusion render limit reached.');
    context.budget.used += 1;
    const inner = renderMarkdown(blockToMarkdown(resolved.block, { includeBlockId: false }), {
      ...context, depth: context.depth + 1, chain: [...context.chain, reference], budget: context.budget,
    });
    return `<aside class="transclusion" role="note" aria-label="Embedded block from ${escapeAttr(note.title)}" contenteditable="false"><a href="#" class="transclusion__source wikilink" data-wikilink="${escapeAttr(note.title)}" data-fragment="^${escapeAttr(id)}">${escapeHtml(note.title)} · ^${escapeHtml(id)}</a><div class="transclusion__body markdown">${inner}</div></aside>`;
  };
}

import { blockSupportsId } from '../utils/block-links.js';

const element = (tag, className) => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

export function createBlockEditorPhase5Enhancer() {
  return {
    prepend(host, editor) {
      if (!editor.frontmatter) return;
      const details = element('details', 'blk-frontmatter');
      const summary = element('summary', 'blk-frontmatter__summary');
      summary.textContent = 'YAML frontmatter source';
      const label = element('label', 'blk-frontmatter__label');
      label.textContent = 'Raw YAML frontmatter';
      const textarea = element('textarea', 'blk-frontmatter__source');
      textarea.value = editor.frontmatter.raw;
      textarea.spellcheck = false;
      textarea.setAttribute('aria-label', 'Raw YAML frontmatter');
      textarea.addEventListener('input', () => editor.setFrontmatterRaw(textarea.value));
      label.appendChild(textarea);
      details.append(summary, label);
      host.appendChild(details);
    },

    decorateRow(row, block, editor) {
      if (!blockSupportsId(block)) return;
      const button = element('button', 'blk-copy-link');
      button.type = 'button';
      button.title = 'Copy block link';
      button.setAttribute('aria-label', 'Copy block link');
      button.textContent = '⌁';
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = editor.assignBlockId(block);
        const link = `[[${editor.noteTitle}#^${id}]]`;
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(link);
          editor.onStatus(`Copied block link ${link}.`);
        } catch {
          editor.onStatus(`Could not copy automatically. Copy this block link: ${link}`);
        }
        editor.host.querySelector(`.blk-row[data-id="${block.id}"] .blk-copy-link`)?.focus();
      });
      row.querySelector('.blk-gutter')?.appendChild(button);
    },
  };
}

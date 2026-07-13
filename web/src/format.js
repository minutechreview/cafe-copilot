// Tiny, dependency-free formatter for assistant chat text. Deliberately does the least
// possible: escape every character of the raw text as HTML first, then apply a handful of
// whitelisted transforms on top of the now-inert, escaped text. Nothing downstream of the
// escape step can introduce a real tag — every `<` a transform inserts is one this module
// wrote itself, never one copied from the input. Applied to assistant messages only; user
// messages are rendered as plain text (see App.jsx) and never need this.
//
// Supported markdown-ish syntax, and nothing else (no headings, links, tables, raw HTML):
//   **bold**        -> <strong>bold</strong>
//   *italic*         -> <em>italic</em>
//   "- item" lines   -> <ul><li>item</li></ul> (consecutive dash lines group into one list)
//   blank line       -> paragraph break
//   single newline   -> <br> within a paragraph

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(raw) {
  return String(raw ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Applies **bold** then *italic* to already-escaped text. Order matters: bold consumes the
 * double asterisks first so a leftover single asterisk pass doesn't split them apart. */
function applyInlineFormatting(text) {
  return text
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g, '<em>$1</em>');
}

const DASH_LIST_ITEM = /^-\s+(.+)$/;

/** Groups escaped lines into paragraph and list blocks, in source order. */
function groupLinesIntoBlocks(escapedText) {
  const blocks = [];
  let paragraphLines = [];
  let listItems = null;

  const flushParagraph = () => {
    if (paragraphLines.length) {
      blocks.push({ type: 'p', html: paragraphLines.join('<br>') });
      paragraphLines = [];
    }
  };
  const flushList = () => {
    if (listItems) {
      blocks.push({ type: 'ul', items: listItems });
      listItems = null;
    }
  };

  for (const line of escapedText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const dashMatch = DASH_LIST_ITEM.exec(trimmed);
    if (dashMatch) {
      flushParagraph();
      (listItems ??= []).push(dashMatch[1]);
    } else {
      flushList();
      paragraphLines.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Formats raw assistant text into a small, safe HTML string suitable for
 * `dangerouslySetInnerHTML`. Every character of `raw` is HTML-escaped before any markdown-ish
 * transform runs, so malicious input (e.g. `<script>...</script>` or `<img onerror=...>`)
 * always ends up as inert escaped text, never as a live tag or attribute.
 * @param {string} raw
 * @returns {string}
 */
export function formatAssistantText(raw) {
  const escaped = escapeHtml(raw);
  const blocks = groupLinesIntoBlocks(escaped);
  return blocks
    .map((block) =>
      block.type === 'ul'
        ? `<ul>${block.items.map((item) => `<li>${applyInlineFormatting(item)}</li>`).join('')}</ul>`
        : `<p>${applyInlineFormatting(block.html)}</p>`
    )
    .join('');
}

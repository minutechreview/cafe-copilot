import { describe, it, expect } from 'vitest';
import { formatAssistantText } from '../src/format.js';

describe('formatAssistantText', () => {
  describe('security: HTML is escaped before any transform runs', () => {
    it('neutralizes a <script> tag instead of letting it through', () => {
      const html = formatAssistantText('<script>alert(1)</script>');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('neutralizes an <img onerror=...> payload', () => {
      const html = formatAssistantText('<img src=x onerror=alert(1)>');
      // The whole tag is inert escaped text — no live <img> element, so the onerror text
      // that does remain is just characters on the page, not a real DOM attribute.
      expect(html).not.toContain('<img');
      expect(html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    });

    it('escapes raw tags mixed in with real content', () => {
      const html = formatAssistantText('Sales were <b>up</b> today.');
      expect(html).toContain('&lt;b&gt;up&lt;/b&gt;');
      expect(html).not.toContain('<b>up</b>');
    });

    it('escapes ampersands, quotes, and angle brackets generally', () => {
      const html = formatAssistantText(`Tom & Jerry's "special" <deal>`);
      expect(html).toContain('Tom &amp; Jerry&#39;s &quot;special&quot; &lt;deal&gt;');
    });

    it('does not let markdown syntax smuggle a real tag through bold/italic', () => {
      // If escaping ran after the markdown transform instead of before, this would produce
      // a live <img> tag. It must not.
      const html = formatAssistantText('**<img src=x onerror=alert(1)>**');
      expect(html).not.toContain('<img');
      expect(html).toContain('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
    });
  });

  describe('bold and italic', () => {
    it('converts **bold** to <strong>', () => {
      expect(formatAssistantText('Gross sales were **LKR 32,400** today.')).toBe(
        '<p>Gross sales were <strong>LKR 32,400</strong> today.</p>'
      );
    });

    it('converts *italic* to <em>', () => {
      expect(formatAssistantText('That was *unusually* high.')).toBe(
        '<p>That was <em>unusually</em> high.</p>'
      );
    });

    it('handles bold and italic together without cross-consuming asterisks', () => {
      expect(formatAssistantText('**Bold** and *italic* text.')).toBe(
        '<p><strong>Bold</strong> and <em>italic</em> text.</p>'
      );
    });
  });

  describe('lists', () => {
    it('groups consecutive dash lines into one <ul>', () => {
      const html = formatAssistantText('Top sellers:\n- Flat white\n- Croissant\n- Iced latte');
      expect(html).toBe(
        '<p>Top sellers:</p><ul><li>Flat white</li><li>Croissant</li><li>Iced latte</li></ul>'
      );
    });

    it('applies inline formatting inside list items', () => {
      const html = formatAssistantText('- **LKR 400** — flat white');
      expect(html).toBe('<ul><li><strong>LKR 400</strong> — flat white</li></ul>');
    });

    it('starts a new list after a paragraph interrupts it', () => {
      const html = formatAssistantText('- one\n- two\nSomething else.\n- three');
      expect(html).toBe(
        '<ul><li>one</li><li>two</li></ul><p>Something else.</p><ul><li>three</li></ul>'
      );
    });
  });

  describe('paragraphs and newlines', () => {
    it('turns a blank line into a paragraph break', () => {
      const html = formatAssistantText('First paragraph.\n\nSecond paragraph.');
      expect(html).toBe('<p>First paragraph.</p><p>Second paragraph.</p>');
    });

    it('turns a single newline into a <br> within one paragraph', () => {
      const html = formatAssistantText('Line one.\nLine two.');
      expect(html).toBe('<p>Line one.<br>Line two.</p>');
    });

    it('returns an empty string for empty input', () => {
      expect(formatAssistantText('')).toBe('');
    });

    it('handles undefined/null input without throwing', () => {
      expect(formatAssistantText(undefined)).toBe('');
      expect(formatAssistantText(null)).toBe('');
    });
  });
});

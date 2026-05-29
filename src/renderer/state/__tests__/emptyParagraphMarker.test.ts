// Regression fixtures for Milkdown's empty-paragraph round-trip marker
// stripper ([RAISE-37](https://risepeople.atlassian.net/browse/RAISE-37);
// widened across RAISE-39 iterations 1-2). `stripEmptyParagraphMarkers`
// drops the literal `<br />` lines Milkdown's paragraph serializer writes
// for empty middle paragraphs, with code-region awareness so a `<br />`
// inside a fenced block (an HTML example) survives.
//
// The marker shapes were widened iteratively from smoke-test feedback;
// this suite pins one case per documented shape so a future regex tweak
// can't silently drop a shape or start eating code-block content. Pure
// string logic, no DOM — runs under the default `node` environment.

import { describe, expect, it } from 'vitest';
import { stripEmptyParagraphMarkers } from '../emptyParagraphMarker';

describe('stripEmptyParagraphMarkers', () => {
  describe('strips the marker (one case per documented shape)', () => {
    it('shape 1: standalone <br /> between two real paragraphs (the prototypical RAISE-37 case)', () => {
      // Two Enters in WYSIWYG → an empty middle paragraph → `<br />` line.
      // The surrounding blank lines collapse back to a single paragraph break.
      expect(stripEmptyParagraphMarkers('Para one.\n\n<br />\n\nPara two.')).toBe(
        'Para one.\n\nPara two.',
      );
    });

    it('shape 1: standalone marker with leading whitespace (indented)', () => {
      expect(stripEmptyParagraphMarkers('  <br />\n')).toBe('');
    });

    it('shape 2: empty unordered list item with `*` marker (RAISE-39 iteration 1)', () => {
      expect(stripEmptyParagraphMarkers('* item\n* <br />\n* item2')).toBe('* item\n\n* item2');
    });

    it('shape 2: empty unordered list item with `-` marker', () => {
      expect(stripEmptyParagraphMarkers('- a\n- <br />\n- b')).toBe('- a\n\n- b');
    });

    it('shape 2: empty unordered list item with `+` marker', () => {
      expect(stripEmptyParagraphMarkers('+ a\n+ <br />\n+ b')).toBe('+ a\n\n+ b');
    });

    it('shape 2: empty unordered list item, indented', () => {
      expect(stripEmptyParagraphMarkers('  * <br />\n')).toBe('');
    });

    it('shape 3: empty task list item, unchecked `* [ ]`', () => {
      expect(stripEmptyParagraphMarkers('* [ ] a\n* [ ] <br />\n* [ ] b')).toBe(
        '* [ ] a\n\n* [ ] b',
      );
    });

    it('shape 3: empty task list item, checked `- [x]`', () => {
      expect(stripEmptyParagraphMarkers('- [x] a\n- [x] <br />\n- [x] b')).toBe(
        '- [x] a\n\n- [x] b',
      );
    });

    it('shape 4: empty ordered list item with `1.` marker (RAISE-39 iteration 2)', () => {
      expect(stripEmptyParagraphMarkers('1. a\n1. <br />\n1. b')).toBe('1. a\n\n1. b');
    });

    it('shape 4: empty ordered list item with `12)` marker (multi-digit, paren delimiter)', () => {
      expect(stripEmptyParagraphMarkers('12) a\n12) <br />\n12) b')).toBe('12) a\n\n12) b');
    });

    it('shape 5: empty blockquote line `> <br />` keeps the quote prefix removed', () => {
      expect(stripEmptyParagraphMarkers('> a\n> <br />\n> b')).toBe('> a\n\n> b');
    });
  });

  describe('does NOT strip (false-positive guards)', () => {
    it('leaves a mid-line <br /> (real content, not a standalone marker)', () => {
      expect(stripEmptyParagraphMarkers('text <br /> more')).toBe('text <br /> more');
    });

    it('leaves a <br /> with attributes (not Milkdown’s exact emit)', () => {
      expect(stripEmptyParagraphMarkers('<br class="x" />')).toBe('<br class="x" />');
    });

    it('leaves a bare <br> without the self-closing slash', () => {
      // Milkdown emits exactly `<br />`; `<br>` is user content.
      expect(stripEmptyParagraphMarkers('<br>')).toBe('<br>');
    });

    it('leaves a marker-shaped line inside a fenced code block (backticks)', () => {
      // A `<br />` in an HTML example must survive verbatim.
      expect(stripEmptyParagraphMarkers('```html\n<br />\n```')).toBe('```html\n<br />\n```');
    });

    it('leaves a marker-shaped line inside a tilde-fenced code block', () => {
      expect(stripEmptyParagraphMarkers('~~~\n<br />\n~~~')).toBe('~~~\n<br />\n~~~');
    });

    it('leaves a <br /> inside inline code', () => {
      expect(stripEmptyParagraphMarkers('use `<br />` inline')).toBe('use `<br />` inline');
    });
  });

  describe('code-region awareness across mixed segments', () => {
    it('strips markers in text regions but preserves the one inside a fence', () => {
      const input = 'A\n\n<br />\n\n```\n<br />\n```\n\n<br />\n\nB';
      // Both standalone text-region markers go; the fenced one stays.
      expect(stripEmptyParagraphMarkers(input)).toBe('A\n\n```\n<br />\n```\n\nB');
    });
  });

  describe('idempotence and fast-path', () => {
    it('running twice produces the same result (idempotent)', () => {
      const input = 'Para one.\n\n<br />\n\nPara two.';
      const once = stripEmptyParagraphMarkers(input);
      expect(stripEmptyParagraphMarkers(once)).toBe(once);
    });

    it('returns the input unchanged when there is no `<br` substring (fast-path)', () => {
      const input = 'no markers here';
      expect(stripEmptyParagraphMarkers(input)).toBe(input);
    });

    it('returns the empty string unchanged', () => {
      expect(stripEmptyParagraphMarkers('')).toBe('');
    });
  });
});

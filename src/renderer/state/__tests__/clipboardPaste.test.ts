// @vitest-environment jsdom
//
// Regression fixtures for the clipboard-paste / serialize post-process
// pipeline ([RAISE-39](https://risepeople.atlassian.net/browse/RAISE-39),
// tightened across five smoke-test iterations). These ~10 regex /
// preprocessing rules decide whether a paste is treated as already-markdown
// (Google Docs / Notion) vs. rich HTML that needs Turndown (Word / Outlook /
// browser pages), then clean up the source-noise each path leaves behind.
// The rules were tuned against a real proprietary corpus; this suite locks
// the behaviour in with craftable fixtures so the next edit can't silently
// break a documented case.
//
// jsdom environment: `preprocessClipboardHtml` / `htmlToMarkdown` use the
// renderer's native `DOMParser`, and `getMarkdownFromClipboard` consumes a
// `DataTransfer`. The default vitest `node` environment has neither, so this
// file opts into jsdom via the docblock above (the pattern documented in
// vitest.config.ts). jsdom does NOT implement `DataTransfer`, so the
// clipboard tests build a minimal `{ getData }` test double cast to the type
// — the function only ever calls `cd.getData(...)`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TurndownService from 'turndown';
import {
  cleanupGoogleDocsMarkdown,
  getMarkdownFromClipboard,
  htmlToMarkdown,
  looksLikeMarkdown,
  preprocessClipboardHtml,
  sanitizeTurndownOutput,
  unescapeHeadingNumberDot,
} from '../clipboardPaste';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

/** Minimal DataTransfer test double — jsdom doesn't implement the real one. */
function fakeClipboard(plain: string, html: string): DataTransfer {
  return {
    getData: (type: string): string =>
      type === 'text/plain' ? plain : type === 'text/html' ? html : '',
  } as unknown as DataTransfer;
}

describe('looksLikeMarkdown', () => {
  describe('positive — strong markers present (Google Docs / Notion paste)', () => {
    it('fires on an ATX heading', () => {
      expect(looksLikeMarkdown('# Heading\n\nbody')).toBe(true);
    });

    it('fires on a fenced code block (backticks)', () => {
      expect(looksLikeMarkdown('```ts\nconst x = 1;\n```')).toBe(true);
    });

    it('fires on a fenced code block (tildes)', () => {
      expect(looksLikeMarkdown('~~~\ncode\n~~~')).toBe(true);
    });

    it('fires on an inline link', () => {
      expect(looksLikeMarkdown('see [the docs](https://example.com)')).toBe(true);
    });

    it('fires on an inline image', () => {
      expect(looksLikeMarkdown('![alt text](https://example.com/x.png)')).toBe(true);
    });

    it('fires on bold delimiters (** and __)', () => {
      expect(looksLikeMarkdown('this is **bold**')).toBe(true);
      expect(looksLikeMarkdown('this is __bold__')).toBe(true);
    });

    it('fires on a Google Docs backslash escape (\\. / \\#)', () => {
      expect(looksLikeMarkdown('1\\. First item')).toBe(true);
      expect(looksLikeMarkdown('\\# not a heading')).toBe(true);
    });

    it('fires on a GFM table row (3+ pipes)', () => {
      expect(looksLikeMarkdown('| col a | col b |')).toBe(true);
    });

    it('fires on the realistic Notion mixed-content fixture', () => {
      expect(looksLikeMarkdown(fixture('notion-mixed.txt'))).toBe(true);
    });
  });

  describe('negative — the tightening cases (rich content with stripped structure)', () => {
    it('does NOT fire on the Outlook reply-quote fixture', () => {
      // Reply markers (`> `), plain bullets (`* `), and plain ordered lists
      // (`1. `) all look superficially like markdown but carry no strong
      // marker — the text/html slot has the real structure.
      expect(looksLikeMarkdown(fixture('outlook-reply-quote.txt'))).toBe(false);
    });

    it('does NOT fire on Word-style plain-text bullets alone', () => {
      expect(looksLikeMarkdown('* first\n* second\n* third')).toBe(false);
      expect(looksLikeMarkdown('- first\n- second')).toBe(false);
    });

    it('does NOT fire on a plain ordered list alone', () => {
      expect(looksLikeMarkdown('1. first\n2. second\n3. third')).toBe(false);
    });

    it('does NOT fire on Outlook reply-quote markers alone', () => {
      expect(looksLikeMarkdown('> quoted line\n> another line')).toBe(false);
    });

    it('does NOT fire on plain italic / single-asterisk text (deliberately omitted marker)', () => {
      expect(looksLikeMarkdown('this is *emphasised* text')).toBe(false);
    });

    it('returns false for empty input', () => {
      expect(looksLikeMarkdown('')).toBe(false);
    });
  });
});

describe('cleanupGoogleDocsMarkdown', () => {
  it('unwraps a double-wrapped link `[[X](u1)](u2)` → `[X](u2)`', () => {
    expect(
      cleanupGoogleDocsMarkdown('[[employee handbook](https://x.com/a)](https://x.com/b)'),
    ).toBe('[employee handbook](https://x.com/b)');
  });

  it('strips a mid-heading digit-dot escape (iteration 1 broadening)', () => {
    // The original narrow regex only matched digits immediately after `#+`;
    // iteration 1 widened it to scan the whole heading line.
    expect(cleanupGoogleDocsMarkdown('### Item 1\\. Foo')).toBe('### Item 1. Foo');
  });

  it('strips a digit-dot escape at heading start', () => {
    expect(cleanupGoogleDocsMarkdown('## 1\\. Intro')).toBe('## 1. Intro');
  });

  it('strips multiple digit-dot escapes on one heading line', () => {
    expect(cleanupGoogleDocsMarkdown('## A 1\\. B 2\\. C')).toBe('## A 1. B 2. C');
  });

  it('strips an ordered-list-start digit-dot escape `1\\. Foo` → `1. Foo`', () => {
    expect(cleanupGoogleDocsMarkdown('1\\. First item')).toBe('1. First item');
  });

  it('strips an indented ordered-list-start escape', () => {
    expect(cleanupGoogleDocsMarkdown('  2\\. Indented')).toBe('  2. Indented');
  });

  it('strips a table-cell hash escape `\\#` → `#`', () => {
    expect(cleanupGoogleDocsMarkdown('| \\# | count |')).toBe('| # | count |');
  });

  it('returns empty input unchanged', () => {
    expect(cleanupGoogleDocsMarkdown('')).toBe('');
  });
});

describe('unescapeHeadingNumberDot', () => {
  it('strips `\\.` after a digit on every heading line, leaving non-heading lines alone', () => {
    const input = '# 1\\. A\ntext 2\\. b\n## C 3\\. d';
    // Heading lines (`# `, `## `) are unescaped; the paragraph line keeps its
    // `\.` (it could be a deliberate literal-period escape).
    expect(unescapeHeadingNumberDot(input)).toBe('# 1. A\ntext 2\\. b\n## C 3. d');
  });

  it('is idempotent (running twice = no further change)', () => {
    const input = '# 1\\. A\ntext 2\\. b\n## C 3\\. d';
    const once = unescapeHeadingNumberDot(input);
    expect(unescapeHeadingNumberDot(once)).toBe(once);
  });

  it('does not touch `\\.` outside heading lines', () => {
    expect(unescapeHeadingNumberDot('a paragraph 5\\. with an escape')).toBe(
      'a paragraph 5\\. with an escape',
    );
  });

  it('fast-paths when the string has no `\\.` substring at all', () => {
    expect(unescapeHeadingNumberDot('# Heading\n\nbody')).toBe('# Heading\n\nbody');
  });
});

describe('sanitizeTurndownOutput', () => {
  it('drops <style> blocks entirely', () => {
    expect(sanitizeTurndownOutput('a<style>x{y}</style>b')).toBe('ab');
  });

  it('drops <script> blocks entirely', () => {
    expect(sanitizeTurndownOutput('a<script>z()</script>b')).toBe('ab');
  });

  it('drops HTML comments', () => {
    expect(sanitizeTurndownOutput('a<!-- c -->b')).toBe('ab');
  });

  it('replaces <br> / <br /> with a single space', () => {
    expect(sanitizeTurndownOutput('a<br>b<br />c')).toBe('a b c');
  });

  it('unwraps <div> / <span> tags, keeping their content', () => {
    expect(sanitizeTurndownOutput('<div><span>hi</span></div>')).toBe('hi');
  });

  it('collapses runs of 2+ spaces left behind by the substitutions', () => {
    expect(sanitizeTurndownOutput('a    b')).toBe('a b');
  });
});

describe('preprocessClipboardHtml (Word-HTML path)', () => {
  it('returns empty input unchanged', () => {
    expect(preprocessClipboardHtml('')).toBe('');
  });

  it('drops the Word <head><style> CSS preamble', () => {
    const out = preprocessClipboardHtml(fixture('word-table.html'));
    // The CSS rule bodies (font-face, style definitions) are gone — they live
    // in the dropped <head><style>. The surviving `class="MsoNormal"`
    // attribute on a body <p> is harmless (Turndown ignores it).
    expect(out).not.toContain('@font-face');
    expect(out).not.toContain('Style Definitions');
    expect(out).not.toContain('panose-1');
  });

  it('promotes a `p.MsoTitle` to an <h1>', () => {
    const out = preprocessClipboardHtml(fixture('word-table.html'));
    expect(out).toMatch(/<h1[^>]*>Quarterly Headcount<\/h1>/);
  });

  it('promotes the first row of a thead-less table to a real <thead>/<th>', () => {
    const out = preprocessClipboardHtml(fixture('word-table.html'));
    expect(out).toContain('<thead>');
    expect(out).toMatch(/<th[^>]*>(<[^>]+>)*Team/);
  });

  it('unwraps block children inside table cells (single-paragraph cell)', () => {
    const out = preprocessClipboardHtml(fixture('word-table.html'));
    // The `<td><p>Engineering</p></td>` cell loses its inner <p> wrapper.
    expect(out).not.toMatch(/<td[^>]*>\s*<p/);
  });

  it('joins multi-paragraph table cells with <br> instead of breaking the row', () => {
    const html = '<table><tr><td><p>Sales</p><p>(west)</p></td><td><p>9</p></td></tr></table>';
    const out = preprocessClipboardHtml(html);
    expect(out).toContain('Sales<br>(west)');
  });
});

describe('htmlToMarkdown — fixture round-trips', () => {
  it('converts the Google Docs policy HTML to the expected markdown', () => {
    expect(htmlToMarkdown(fixture('google-docs-policy.html'))).toBe(
      fixture('google-docs-policy.expected.md'),
    );
  });

  it('converts the Word headerless-table HTML to a clean GFM table', () => {
    expect(htmlToMarkdown(fixture('word-table.html'))).toBe(fixture('word-table.expected.md'));
  });

  it('returns empty string for empty HTML', () => {
    expect(htmlToMarkdown('')).toBe('');
  });
});

describe('getMarkdownFromClipboard — branch selection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('text/plain wins when a strong markdown marker is present (with Google Docs cleanup)', () => {
    const cd = fakeClipboard(
      '# Title\n\nSee [[link](http://a)](http://b) and 1\\. item',
      '<p>html version</p>',
    );
    // The double-wrapped link is unwrapped; the mid-line `1\.` is left as-is
    // (cleanup's ordered-list rule only fires at line start). The HTML slot
    // is ignored because plain text already looks like markdown.
    expect(getMarkdownFromClipboard(cd)).toBe('# Title\n\nSee [link](http://b) and 1\\. item');
  });

  it('falls through to the HTML branch when text/plain is not markdown', () => {
    const cd = fakeClipboard('plain bullets\n* one\n* two', '<h1>Heading</h1><p>body</p>');
    expect(getMarkdownFromClipboard(cd)).toBe('# Heading\n\nbody');
  });

  it('falls back to plain text when Turndown throws on the HTML', () => {
    vi.spyOn(TurndownService.prototype, 'turndown').mockImplementation(() => {
      throw new Error('turndown blew up');
    });
    const cd = fakeClipboard('plain fallback text', '<p>some html</p>');
    expect(getMarkdownFromClipboard(cd)).toBe('plain fallback text');
  });

  it('returns null when Turndown throws and there is no plain text', () => {
    vi.spyOn(TurndownService.prototype, 'turndown').mockImplementation(() => {
      throw new Error('turndown blew up');
    });
    const cd = fakeClipboard('', '<p>some html</p>');
    expect(getMarkdownFromClipboard(cd)).toBeNull();
  });

  it('returns null for an entirely empty clipboard', () => {
    expect(getMarkdownFromClipboard(fakeClipboard('', ''))).toBeNull();
  });

  it('returns plain text when there is no HTML slot and no markdown marker', () => {
    expect(getMarkdownFromClipboard(fakeClipboard('just some words', ''))).toBe('just some words');
  });
});

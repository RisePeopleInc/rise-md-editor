// Regression fixtures for the markdown-it comment rules
// ([RAISE-31](https://risepeople.atlassian.net/browse/RAISE-31),
// multi-line + typographer fixes
// [RAISE-48](https://risepeople.atlassian.net/browse/RAISE-48);
// pinned with unit coverage in
// [RAISE-41](https://risepeople.atlassian.net/browse/RAISE-41)).
//
// `markdownItComments` registers three custom rules that render
// review-style comments muted in the preview pane:
//
//   1. inline `<!-- ... -->`  → `<span class="md-comment">`
//   2. block  `<!-- ... -->`  (multi-line) → `<div class="md-comment">`
//   3. line   `// ...`        → `<p class="md-comment">`
//
// These run as pure string → HTML transforms (markdown-it never
// touches the DOM), so this file stays in the default `node`
// vitest environment — no jsdom docblock needed.
//
// The instance config mirrors the real preview pipeline
// (`SplitView.tsx` / `exportPdfHtml.ts`): `html: false`,
// `linkify: true`, `typographer: true`, `breaks: false`. That
// matters — the rules exist *because* `html: false` would
// otherwise escape `<!-- -->` to visible text, and the
// typographer suppression inside the rules is what keeps literal
// `--` inside a comment body from collapsing to an en-dash.

import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { markdownItComments } from '../markdownItComments';

/** Build a markdown-it instance configured like the preview pane. */
function makeMd(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
  });
  md.use(markdownItComments);
  return md;
}

describe('markdownItComments — inline HTML comments', () => {
  it('renders an inline comment with no inner content as an empty styled span', () => {
    // The degenerate `<!---->` shape: delimiters detected, inner src
    // empty after trim, so the span carries no children.
    expect(makeMd().render('<!---->')).toBe('<p><span class="md-comment"></span></p>\n');
  });

  it('renders an inline comment with plain inner text', () => {
    expect(makeMd().render('<!-- just text -->')).toBe(
      '<p><span class="md-comment">just text</span></p>\n',
    );
  });

  it('recursively parses a link inside an inline comment', () => {
    // Iteration-1 fix #1: the inner content is run back through the
    // inline tokenizer so `[link](url)` becomes a real anchor rather
    // than verbatim text.
    expect(makeMd().render('<!-- see [link](https://x.com) -->')).toBe(
      '<p><span class="md-comment">see <a href="https://x.com">link</a></span></p>\n',
    );
  });

  it('recursively parses bold and italic inside an inline comment', () => {
    expect(makeMd().render('<!-- **bold** and *em* -->')).toBe(
      '<p><span class="md-comment"><strong>bold</strong> and <em>em</em></span></p>\n',
    );
  });

  it('keeps a comment mid-paragraph inline with surrounding prose', () => {
    expect(makeMd().render('before <!-- note --> after')).toBe(
      '<p>before <span class="md-comment">note</span> after</p>\n',
    );
  });

  it('preserves literal `--` inside a comment body (typographer suppressed)', () => {
    // RAISE-48 sub-bug B: without the per-rule typographer toggle the
    // `--` would collapse to an en-dash.
    expect(makeMd().render('<!-- foo -- bar -->')).toBe(
      '<p><span class="md-comment">foo -- bar</span></p>\n',
    );
  });
});

describe('markdownItComments — line comments', () => {
  it('renders a `// note` line as a styled paragraph with the `//` hidden', () => {
    expect(makeMd().render('// a line comment')).toBe(
      '<p class="md-comment">a line comment</p>\n',
    );
  });

  it('renders an indented `// note` line (tShift accounts for leading whitespace)', () => {
    // Iteration-3 motivation: indented notes are common; leading
    // whitespace must not stop the rule from matching.
    expect(makeMd().render('   // indented line comment')).toBe(
      '<p class="md-comment">indented line comment</p>\n',
    );
  });

  it('renders two adjacent `// note` lines as separate styled paragraphs', () => {
    expect(makeMd().render('// first\n// second')).toBe(
      '<p class="md-comment">first</p>\n<p class="md-comment">second</p>\n',
    );
  });

  it('does NOT match a mid-line `//` (URL guard — only line-start counts)', () => {
    // `https://...//...` must linkify normally, never be swallowed as
    // a comment. The block rule is anchored to the first non-blank
    // char of the line.
    expect(makeMd().render('Visit https://example.com/a//b for more')).toBe(
      '<p>Visit <a href="https://example.com/a//b">https://example.com/a//b</a> for more</p>\n',
    );
  });
});

describe('markdownItComments — block (multi-line) HTML comments', () => {
  it('renders a comment spanning two lines as a styled div', () => {
    expect(makeMd().render('<!-- line one\nline two -->')).toBe(
      '<div class="md-comment">\n<p>line one\nline two</p>\n</div>\n',
    );
  });

  it('recursively block-parses headings and lists inside a multi-line comment', () => {
    // RAISE-48 sub-bug A: inner markdown still formats (heading, list)
    // but the whole block renders muted.
    expect(makeMd().render('<!--\n# Heading inside\n- list item\n-->')).toBe(
      '<div class="md-comment">\n<h1>Heading inside</h1>\n<ul>\n<li>list item</li>\n</ul>\n</div>\n',
    );
  });

  it('leaves an unclosed `<!--` to the default rules (no runaway comment block)', () => {
    // The unclosed-comment fall-through: a half-typed `<!--` must not
    // swallow the rest of the doc. With `html: false` the default
    // rules escape it to visible text.
    const out = makeMd().render('<!-- unterminated\nmore text');
    expect(out).not.toContain('md-comment');
    expect(out).toContain('&lt;!-- unterminated');
  });
});

describe('markdownItComments — code regions stay literal', () => {
  it('does NOT match `// ` or `<!-- -->` inside a fenced code block', () => {
    // markdown-it's `fence` rule consumes the lines before our block
    // rules see them, and `html: false` escapes the delimiters.
    expect(makeMd().render('```\n// not a comment\n<!-- nope -->\n```')).toBe(
      '<pre><code>// not a comment\n&lt;!-- nope --&gt;\n</code></pre>\n',
    );
  });

  it('does NOT match `<!-- -->` inside an inline code span', () => {
    // The inline rule fires during normal-text inline parsing, which
    // never enters code-span content.
    expect(makeMd().render('`<!-- not a comment -->`')).toBe(
      '<p><code>&lt;!-- not a comment --&gt;</code></p>\n',
    );
  });
});

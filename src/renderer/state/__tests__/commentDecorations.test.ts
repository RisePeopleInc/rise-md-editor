// RAISE-41: regression fixtures for the comment-decoration helpers in
// `commentDecorations.ts`. Covers the two pure serialize-side unescape
// functions and the `buildDecorations` doc walk. The unescape functions
// lock in the regex tuning from RAISE-31's iteration rounds (escaped
// comment-open strip, inner-content unescape incl. the gfm-autolink trio,
// the literal `\\<!--` edge case, idempotence). `buildDecorations` is
// exercised against a minimal ProseMirror schema that mirrors only the
// node shapes the function inspects — no full Milkdown editor needed, and
// no DOM (Decoration/DecorationSet are pure data structures), so this file
// stays in the default `node` env. The EditorView plugin-lifecycle path
// (mount / typing / paste re-decoration) needs a real editor under jsdom
// and is left as a follow-up — `buildDecorations` is the logic it drives.
import { describe, it, expect } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/prose/model';
import {
  unescapeCommentDelimiters,
  unescapeIndentEntities,
  buildDecorations,
} from '../commentDecorations';

describe('unescapeCommentDelimiters', () => {
  it('returns the input unchanged when there is no comment', () => {
    expect(unescapeCommentDelimiters('plain text, no comment here')).toBe(
      'plain text, no comment here',
    );
    expect(unescapeCommentDelimiters('')).toBe('');
  });

  it('strips the leading backslash from an escaped comment open', () => {
    expect(unescapeCommentDelimiters('\\<!-- a note -->')).toBe('<!-- a note -->');
  });

  it('leaves a clean (unescaped) comment open untouched', () => {
    expect(unescapeCommentDelimiters('<!-- a note -->')).toBe('<!-- a note -->');
  });

  it('unescapes backslash-escaped markdown-syntax chars inside the comment', () => {
    expect(
      unescapeCommentDelimiters('<!-- \\[link\\]\\(url\\) \\*x\\* \\# \\` \\~ \\| -->'),
    ).toBe('<!-- [link](url) *x* # ` ~ | -->');
  });

  it('unescapes the gfm-autolink-literal trio (\\: \\. \\@)', () => {
    expect(unescapeCommentDelimiters('<!-- see https\\://example.com -->')).toBe(
      '<!-- see https://example.com -->',
    );
    expect(unescapeCommentDelimiters('<!-- www\\.example.com -->')).toBe(
      '<!-- www.example.com -->',
    );
    expect(unescapeCommentDelimiters('<!-- user\\@host.com -->')).toBe('<!-- user@host.com -->');
  });

  it('does NOT strip a literal escaped backslash before the comment open (\\\\<!--)', () => {
    // `\\<!--` is a user-intended literal backslash followed by a comment
    // open; the negative lookbehind leaves the backslash in place.
    expect(unescapeCommentDelimiters('\\\\<!-- a -->')).toBe('\\\\<!-- a -->');
  });

  it('is idempotent (running twice equals running once)', () => {
    const input = '\\<!-- \\[x\\] at https\\://y.com -->';
    const once = unescapeCommentDelimiters(input);
    expect(unescapeCommentDelimiters(once)).toBe(once);
    expect(once).toBe('<!-- [x] at https://y.com -->');
  });
});

describe('unescapeIndentEntities', () => {
  it('returns the input unchanged when there is no entity', () => {
    expect(unescapeIndentEntities('no entity here')).toBe('no entity here');
    expect(unescapeIndentEntities('')).toBe('');
  });

  it('replaces a single &#x20; with a literal space', () => {
    expect(unescapeIndentEntities('&#x20;// an indented note')).toBe(' // an indented note');
  });

  it('replaces multiple &#x20; entities (deeper indent)', () => {
    expect(unescapeIndentEntities('&#x20;&#x20;&#x20;&#x20;deep')).toBe('    deep');
  });

  it('preserves surrounding content', () => {
    expect(unescapeIndentEntities('a&#x20;b&#x20;c')).toBe('a b c');
  });
});

// Minimal ProseMirror schema mirroring only the node shapes
// `buildDecorations` inspects: a textblock (`paragraph`), an inline `html`
// atom carrying a `value` attr, and a `code: true` block it must skip.
// Faithful to the properties the function reads (`node.type.spec.code`,
// `node.type.name`, `node.attrs.value`, `node.isTextblock`,
// `node.textContent`) without standing up the full Milkdown editor.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    code_block: {
      group: 'block',
      content: 'text*',
      code: true,
      toDOM: () => ['pre', ['code', 0]],
    },
    text: { group: 'inline' },
    html: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { value: { default: '' } },
      toDOM: () => ['span'],
    },
  },
});
const para = (...inline: ProseNode[]): ProseNode => schema.node('paragraph', null, inline);
const docOf = (...blocks: ProseNode[]): ProseNode => schema.node('doc', null, blocks);

describe('buildDecorations', () => {
  it('decorates an inline html comment node', () => {
    const doc = docOf(para(schema.node('html', { value: '<!-- a comment -->' })));
    expect(buildDecorations(doc).find().length).toBe(1);
  });

  it('does NOT decorate an html node that is not a comment', () => {
    const doc = docOf(para(schema.node('html', { value: '<br />' })));
    expect(buildDecorations(doc).find().length).toBe(0);
  });

  it('decorates a line-comment textblock (// note fast-path)', () => {
    const doc = docOf(para(schema.text('// a standalone note')));
    expect(buildDecorations(doc).find().length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT decorate ordinary prose', () => {
    const doc = docOf(para(schema.text('just some ordinary text')));
    expect(buildDecorations(doc).find().length).toBe(0);
  });

  it('skips a code block whose content looks like a comment', () => {
    const doc = docOf(schema.node('code_block', null, schema.text('// not a real comment')));
    expect(buildDecorations(doc).find().length).toBe(0);
  });

  it('decorates a comment without disturbing a sibling prose paragraph', () => {
    const doc = docOf(
      para(schema.text('intro paragraph')),
      para(schema.node('html', { value: '<!-- note -->' })),
      para(schema.text('outro paragraph')),
    );
    expect(buildDecorations(doc).find().length).toBe(1);
  });
});

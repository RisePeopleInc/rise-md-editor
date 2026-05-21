// Fingerprint test for `looksLikeBareAutolink`
// ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)
// landed the function; RAISE-50 pins it with unit coverage).
//
// `looksLikeBareAutolink` is the parse-side mirror of
// `isSyntheticAutolinkMark`: it inspects an mdast `link` node and
// decides whether the node was emitted by
// `mdast-util-gfm-autolink-literal`'s parser (which synthesises an
// `http://` scheme in front of bare-host text like `file.md`) vs.
// being an intentional `[text](url)` link a user typed.
//
// The fingerprint is intentionally narrow:
//
//   1. Single text child (no nested formatting).
//   2. url is exactly `http://<text>` or `https://<text>` (the
//      autolink-literal output shape).
//   3. The text doesn't itself start with a scheme.
//   4. The url doesn't start with `mailto:`.
//   5. The text's suffix is in the file-extension list — real-TLD
//      autolinks (`internet.com` → `http://internet.com`) stay
//      autolinked.
//
// We construct `Link` nodes by hand here to keep the test free of
// the remark parser dependency.
import { describe, expect, it } from 'vitest';
import type { Link, Text } from 'mdast';
import { looksLikeBareAutolink } from '../remarkUnautolink';

/** Build a minimal mdast `link` node with a single text child. */
function makeLink(text: string, url: string): Link {
  const child: Text = { type: 'text', value: text };
  return { type: 'link', url, children: [child] };
}

describe('looksLikeBareAutolink', () => {
  it('fires for a filename-shaped autolink-literal output', () => {
    // The canonical `mdast-util-gfm-autolink-literal` output
    // shape: visible text `file.md`, url synthesised as
    // `http://file.md`. This is exactly what the plugin reverts
    // to plain text on render.
    expect(looksLikeBareAutolink(makeLink('file.md', 'http://file.md'))).toBe(true);
    expect(looksLikeBareAutolink(makeLink('notes.txt', 'http://notes.txt'))).toBe(true);
    expect(looksLikeBareAutolink(makeLink('config.json', 'https://config.json'))).toBe(true);
  });

  it('does not fire for real-TLD autolinks (`www.cbc.ca`, `internet.com`)', () => {
    // The RAISE-47 over-revert regression case — the previous
    // implementation reverted ANY synthesised-scheme autolink,
    // which clobbered legitimate bare-host URLs. The fix gates
    // on the filename-extension list.
    expect(looksLikeBareAutolink(makeLink('www.cbc.ca', 'http://www.cbc.ca'))).toBe(false);
    expect(looksLikeBareAutolink(makeLink('internet.com', 'http://internet.com'))).toBe(false);
    expect(looksLikeBareAutolink(makeLink('example.org', 'http://example.org'))).toBe(false);
  });

  it('does not fire for explicit-scheme URLs typed by the user', () => {
    // The user typed `https://example.com` literally — the
    // visible text already has the scheme, so it isn't the
    // autolink-literal output shape.
    expect(looksLikeBareAutolink(makeLink('https://example.com', 'https://example.com'))).toBe(
      false,
    );
    // Also covers the partial-scheme false-positive case.
    expect(looksLikeBareAutolink(makeLink('http://file.md', 'http://file.md'))).toBe(false);
  });

  it('does not fire for email autolinks (`mailto:` urls)', () => {
    expect(looksLikeBareAutolink(makeLink('user@example.com', 'mailto:user@example.com'))).toBe(
      false,
    );
  });

  it('does not fire when url === text (explicit `[text](text)` syntax)', () => {
    // The fingerprint requires url === `http://${text}` or
    // `https://${text}` — equality without a synthesised scheme
    // prefix is the user-typed `[file.md](file.md)` shape and
    // must stay a link.
    expect(looksLikeBareAutolink(makeLink('file.md', 'file.md'))).toBe(false);
  });

  it('does not fire when the link has more than one child', () => {
    // Nested formatting (e.g. emphasis inside the link text)
    // means the user shaped this explicitly — not a parser-
    // synthesised autolink.
    const child1: Text = { type: 'text', value: 'file' };
    const child2: Text = { type: 'text', value: '.md' };
    const node: Link = {
      type: 'link',
      url: 'http://file.md',
      children: [child1, child2],
    };
    expect(looksLikeBareAutolink(node)).toBe(false);
  });

  it('does not fire when url has a mismatched suffix or scheme', () => {
    // The url body has to be exactly the visible text. Anything
    // else means the link is intentional.
    expect(looksLikeBareAutolink(makeLink('file.md', 'http://file.md/path'))).toBe(false);
    expect(looksLikeBareAutolink(makeLink('file.md', 'ftp://file.md'))).toBe(false);
  });
});

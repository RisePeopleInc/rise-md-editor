// Fingerprint test for `isSyntheticAutolinkMark`
// ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)
// landed the function; RAISE-50 pins it with unit coverage).
//
// `isSyntheticAutolinkMark` is the discriminator that decides
// whether a link mark on a text run was injected by Chromium's
// contenteditable URL auto-detector (synthesised `http://` scheme
// in front of plain text) vs. typed / pasted / parsed intentionally.
// The wrong answer in either direction is user-visible:
//
//   - False positive: strips a legitimate pasted or typed link.
//   - False negative: leaves the partial-URL link mark behind,
//     which serialises as `https://www.[example.com](http://example.com)`
//     on disk — ugly partial-wrap.
//
// The fingerprint is intentionally narrow: only fires when the
// href is the visible text prefixed with `http(s)://` AND the
// stripped href body looks like a file extension (so `www.cbc.ca`
// stays linked, `file.md` doesn't).
import { describe, expect, it } from 'vitest';
import { isSyntheticAutolinkMark } from '../stripBrowserAutolink';

describe('isSyntheticAutolinkMark', () => {
  describe('matches (returns true)', () => {
    it('fires when href is text with synthesised http:// and text is filename-shaped', () => {
      expect(isSyntheticAutolinkMark('file.md', 'http://file.md')).toBe(true);
    });

    it('fires when text contains the filename-shaped href body (wider <a> scope)', () => {
      // The "looser" form documented in the source — Chromium can
      // scope its `<a>` tag wider than the URL substring, so we
      // also accept the case where the text run merely CONTAINS
      // the href body.
      expect(isSyntheticAutolinkMark('...file.md...', 'http://file.md')).toBe(true);
    });

    it('fires for https synthesised scheme too', () => {
      expect(isSyntheticAutolinkMark('config.json', 'https://config.json')).toBe(true);
    });
  });

  describe('does not match (returns false)', () => {
    it('skips mailto links (intentional autolinks)', () => {
      expect(isSyntheticAutolinkMark('user@example.com', 'mailto:user@example.com')).toBe(false);
    });

    it('skips real-TLD URLs (the RAISE-47 over-strip regression case)', () => {
      // The original RAISE-47 strip removed ANY synthesised-scheme
      // mark, clobbering legitimate `www.cbc.ca`-style links. The
      // fix gates on the `looksLikeFilenameExtension` check.
      expect(isSyntheticAutolinkMark('www.cbc.ca', 'http://www.cbc.ca')).toBe(false);
      expect(isSyntheticAutolinkMark('example.com', 'http://example.com')).toBe(false);
    });

    it('skips text that already starts with a scheme (user typed the URL whole)', () => {
      // Chromium injects the synthesised-scheme href; if the text
      // run ALREADY has a scheme, the link is intentional and
      // matches the user's typed URL.
      expect(isSyntheticAutolinkMark('https://example.com', 'http://https://example.com')).toBe(
        false,
      );
      expect(isSyntheticAutolinkMark('http://file.md', 'http://http://file.md')).toBe(false);
    });

    it('skips when href has no http(s) scheme at all', () => {
      // Pasted / explicit links with a non-http scheme (or
      // scheme-relative paths) aren't browser-injected
      // autolinks — leave them alone.
      expect(isSyntheticAutolinkMark('file.md', 'ftp://file.md')).toBe(false);
      expect(isSyntheticAutolinkMark('file.md', '/file.md')).toBe(false);
    });

    it('skips empty inputs', () => {
      expect(isSyntheticAutolinkMark('', 'http://file.md')).toBe(false);
      expect(isSyntheticAutolinkMark('file.md', '')).toBe(false);
    });

    it('skips when href body does not appear in the text run', () => {
      // The strict / loose match check fails — the text doesn't
      // contain `file.md` anywhere, so it isn't a wrap of the
      // same URL.
      expect(isSyntheticAutolinkMark('something else', 'http://file.md')).toBe(false);
    });
  });
});

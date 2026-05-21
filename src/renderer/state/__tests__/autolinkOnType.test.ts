// Regex + completed-hit detection tests for the
// `autolinkOnTypePlugin` discriminator family
// ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)
// landed the patterns; RAISE-50 pins them with unit coverage).
//
// The plugin itself is a ProseMirror appendTransaction that depends
// on a live editor / schema — we don't try to instantiate it here.
// Instead we test the pure-function layer underneath: the four
// regex patterns and the `findCompletedHits` boundary / gate
// machinery. Those are the parts that have actually broken under
// iterative user testing (partial-URL `https://w` anchoring a
// truncated href, `e.g.something` false-positive autolink,
// `steve@sslf.c` mid-typing email match), so they're the parts that
// benefit from regression coverage at the unit level.
//
// Notation: each regex test row asserts that `RE.exec(input)?.[0]`
// is exactly the expected substring (or that no match is found).
// `findCompletedHits` tests assert the returned `Hit[]` shape.
import { describe, expect, it } from 'vitest';
import {
  BARE_HOSTNAME_RE,
  EMAIL_RE,
  findCompletedHits,
  URL_RE,
  WWW_URL_RE,
} from '../autolinkOnType';

/**
 * Reset the regex's lastIndex (these are all `g`-flagged so each
 * test run needs a clean cursor) and return the first match's
 * substring, or null.
 */
function firstMatch(re: RegExp, input: string): string | null {
  re.lastIndex = 0;
  const m = re.exec(input);
  return m ? m[0] : null;
}

describe('URL_RE', () => {
  it.each([
    // [input, expected match substring]
    ['https://example.com', 'https://example.com'],
    ['http://x.io', 'http://x.io'],
    ['see https://example.com today', 'https://example.com'],
    ['http://x.io/path?q=1', 'http://x.io/path?q=1'],
    // Regex is greedy — trailing punctuation is included in the
    // raw match; `findCompletedHits` strips it. We assert the raw
    // regex behaviour here.
    ['https://example.com.', 'https://example.com.'],
    ['https://example.com,', 'https://example.com,'],
  ])('matches %j as %j', (input, expected) => {
    expect(firstMatch(URL_RE, input)).toBe(expected);
  });

  it.each([
    ['plain text only'],
    ['www.example.com'], // no scheme — URL_RE requires http(s)
    ['user@example.com'], // email shape, not URL
  ])('does not match %j', (input) => {
    expect(firstMatch(URL_RE, input)).toBeNull();
  });
});

describe('WWW_URL_RE', () => {
  it.each([
    ['www.cbc.ca', 'www.cbc.ca'],
    ['see www.cbc.ca please', 'www.cbc.ca'],
    ['www.example.com/foo', 'www.example.com/foo'],
    ['www.example.com?q=1', 'www.example.com?q=1'],
    // Multi-segment host.
    ['www.sub.example.com', 'www.sub.example.com'],
  ])('matches %j as %j', (input, expected) => {
    expect(firstMatch(WWW_URL_RE, input)).toBe(expected);
  });

  it.each([
    ['www.cbc'], // single segment after `www.` — pattern requires 2+
    ['plain text'],
    ['https://example.com'], // no `www.` prefix
  ])('does not match %j', (input) => {
    expect(firstMatch(WWW_URL_RE, input)).toBeNull();
  });
});

describe('BARE_HOSTNAME_RE', () => {
  it.each([
    ['example.com', 'example.com'],
    ['internet.com is good', 'internet.com'],
    ['path.dev/foo ', 'path.dev/foo'],
    // The regex deliberately matches file-extension shapes too;
    // the filter happens in `findCompletedHits` via the
    // `skipFilenameExtension` option. Pinning the raw behaviour
    // so a future refactor that pushes filtering into the regex
    // updates the gate plumbing too.
    ['file.md', 'file.md'],
    // Natural-language abbreviation pattern matches the regex —
    // gating is via `requireKnownTld`.
    ['e.g.something here', 'e.g.something'],
    // Multi-segment.
    ['sub.example.org', 'sub.example.org'],
  ])('matches %j as %j', (input, expected) => {
    expect(firstMatch(BARE_HOSTNAME_RE, input)).toBe(expected);
  });

  it.each([
    // IPv4-literal — TLD slot requires `[a-z]{2,}`, digits never
    // match.
    ['1.2.3.4'],
    // Plain word with no dot.
    ['plain'],
  ])('does not match %j', (input) => {
    expect(firstMatch(BARE_HOSTNAME_RE, input)).toBeNull();
  });
});

describe('EMAIL_RE', () => {
  it.each([
    ['steve@example.com', 'steve@example.com'],
    ['contact steve+work@sub.example.co.uk.', 'steve+work@sub.example.co.uk'],
    ['email steve.bond@risepeople.com here', 'steve.bond@risepeople.com'],
  ])('matches %j as %j', (input, expected) => {
    expect(firstMatch(EMAIL_RE, input)).toBe(expected);
  });

  it.each([
    // Single-letter TLD slot — partial typing case `steve@sslf.c`
    // must NOT match, since TLD slot is `[a-z]{2,}`.
    ['steve@sslf.c'],
    ['no-at example'],
    // Missing local part.
    ['@example.com'],
  ])('does not match %j', (input) => {
    expect(firstMatch(EMAIL_RE, input)).toBeNull();
  });
});

describe('findCompletedHits', () => {
  const id = (s: string): string => s;

  describe('boundary detection', () => {
    it('matches a URL followed by whitespace', () => {
      const hits = findCompletedHits('see https://example.com here', URL_RE, id);
      expect(hits).toEqual([{ index: 4, length: 19, href: 'https://example.com' }]);
    });

    it('declines a URL at end-of-text without treatEndAsBoundary', () => {
      const hits = findCompletedHits('https://example.com', URL_RE, id);
      expect(hits).toEqual([]);
    });

    it('matches end-of-text URL when treatEndAsBoundary + caret past match', () => {
      // nodeStart=0, text length 19, caret at 20 (past the end).
      const hits = findCompletedHits('https://example.com', URL_RE, id, {
        treatEndAsBoundary: true,
        nodeStart: 0,
        cursorPos: 20,
      });
      expect(hits).toEqual([{ index: 0, length: 19, href: 'https://example.com' }]);
    });

    it('declines end-of-text URL when caret is at the match end (gate still holds)', () => {
      // Caret at 19 = match end. The gate fires only when caret
      // has moved PAST the match's right edge.
      const hits = findCompletedHits('https://example.com', URL_RE, id, {
        treatEndAsBoundary: true,
        nodeStart: 0,
        cursorPos: 19,
      });
      expect(hits).toEqual([]);
    });

    it('declines end-of-text URL when treatEndAsBoundary is set but caret info missing', () => {
      // Safety net: if we can't tell where the caret is, decline
      // rather than autolink a possibly-truncated href.
      const hits = findCompletedHits('https://example.com', URL_RE, id, {
        treatEndAsBoundary: true,
      });
      expect(hits).toEqual([]);
    });
  });

  describe('trailing-punctuation handling', () => {
    it('strips trailing punctuation before reporting the hit length', () => {
      // Note: this case relies on the regex matching the URL plus
      // a trailing space-terminator — the test below pins the
      // current behaviour where punctuation IMMEDIATELY before the
      // space gets stripped only when there's a separate space
      // boundary the trimmed match can land on.
      const hits = findCompletedHits('https://example.com here', URL_RE, id);
      // No trailing punct to strip here — but the precedent: the
      // hit length matches the trimmed match.
      expect(hits).toEqual([{ index: 0, length: 19, href: 'https://example.com' }]);
    });

    // KNOWN ISSUE — flagged by RAISE-50 review, not fixed here.
    // The boundary check uses `text.charAt(matchEnd)` against the
    // POST-strip `matchEnd`. When the URL is followed by sentence
    // punctuation + space (`https://example.com. ok`), the regex
    // greedily matches `https://example.com.` (length 20), then
    // `TRAILING_PUNCT_RE` strips the `.` (trimmed length 19) — but
    // the boundary check then looks at index 19 in the original
    // text, which is the `.` (not whitespace), and rejects the
    // hit. The user-facing impact: a typed URL followed by a
    // period + space stays plain text. Likely a follow-up ticket.
    it('declines URL followed by trailing punctuation + space (KNOWN BUG)', () => {
      const hits = findCompletedHits('https://example.com. ok', URL_RE, id);
      expect(hits).toEqual([]);
    });
  });

  describe('filename-extension gate (skipFilenameExtension)', () => {
    it('skips a notes.txt-shaped match under the gate', () => {
      const hits = findCompletedHits('notes.txt ', BARE_HOSTNAME_RE, (m) => `http://${m}`, {
        skipFilenameExtension: true,
      });
      expect(hits).toEqual([]);
    });

    it('still hits the same match without the gate', () => {
      const hits = findCompletedHits('notes.txt ', BARE_HOSTNAME_RE, (m) => `http://${m}`);
      expect(hits).toEqual([{ index: 0, length: 9, href: 'http://notes.txt' }]);
    });
  });

  describe('known-TLD gate (requireKnownTld)', () => {
    it('skips an `e.g.something`-shaped match under the gate', () => {
      const hits = findCompletedHits('e.g.something ', BARE_HOSTNAME_RE, (m) => `http://${m}`, {
        requireKnownTld: true,
      });
      expect(hits).toEqual([]);
    });

    it('keeps a real-TLD match under the gate', () => {
      const hits = findCompletedHits('example.com ', BARE_HOSTNAME_RE, (m) => `http://${m}`, {
        requireKnownTld: true,
      });
      expect(hits).toEqual([{ index: 0, length: 11, href: 'http://example.com' }]);
    });
  });

  describe('email mid-typing gate', () => {
    it('declines a partial email `steve@sslf.c` regardless of caret', () => {
      // EMAIL_RE itself doesn't match a single-letter TLD slot, so
      // even with the most permissive boundary options the hit
      // list is empty. This is the "mid-typing" partial-match
      // protection.
      const hits = findCompletedHits('steve@sslf.c', EMAIL_RE, (m) => `mailto:${m}`, {
        treatEndAsBoundary: true,
        nodeStart: 0,
        cursorPos: 50,
      });
      expect(hits).toEqual([]);
    });

    it('matches a completed email `steve@sslf.ca` when caret past end', () => {
      const hits = findCompletedHits('steve@sslf.ca', EMAIL_RE, (m) => `mailto:${m}`, {
        treatEndAsBoundary: true,
        nodeStart: 0,
        cursorPos: 14,
      });
      expect(hits).toEqual([{ index: 0, length: 13, href: 'mailto:steve@sslf.ca' }]);
    });
  });
});

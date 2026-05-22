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

    // RAISE-66 fix: the boundary check now walks past stripped
    // trailing-punct chars to find the actual separator. Before the
    // fix, `https://example.com. ok` greedy-matched `https://example.com.`
    // (length 20), trimmed to 19, and then text.charAt(19) returned
    // `.` (the stripped char), failing the whitespace boundary check
    // and rejecting the hit. The user-facing impact was a typed URL
    // followed by a period + space stayed plain text.
    it('autolinks a URL followed by trailing period + space (RAISE-66)', () => {
      const hits = findCompletedHits('https://example.com. ok', URL_RE, id);
      expect(hits).toEqual([{ index: 0, length: 19, href: 'https://example.com' }]);
    });

    // Every char in TRAILING_PUNCT_RE's set must trim cleanly and
    // still resolve the boundary check past the punct. Spot-check
    // each: period, comma, exclamation, question, semicolon, colon,
    // right-paren, right-bracket.
    it.each([
      ['period', 'https://example.com. ok'],
      ['comma', 'https://example.com, ok'],
      ['exclamation', 'https://example.com! ok'],
      ['question', 'https://example.com? ok'],
      ['semicolon', 'https://example.com; ok'],
      ['colon', 'https://example.com: ok'],
      ['right-paren', 'https://example.com) ok'],
      ['right-bracket', 'https://example.com] ok'],
    ])('autolinks URL followed by %s + space', (_label, text) => {
      const hits = findCompletedHits(text, URL_RE, id);
      expect(hits).toEqual([{ index: 0, length: 19, href: 'https://example.com' }]);
    });

    // Stacked trailing punct (`...!`, `?!`) also strips and resolves
    // the boundary past the run.
    it('autolinks URL followed by stacked trailing punctuation + space', () => {
      const hits = findCompletedHits('https://example.com?! Whoa', URL_RE, id);
      expect(hits).toEqual([{ index: 0, length: 19, href: 'https://example.com' }]);
    });

    // No space between punct and the next chunk → the greedy URL
    // regex keeps consuming, so the boundary char is whatever's
    // beyond. `https://example.com.https://second.com` has no
    // valid boundary anywhere; URL_RE matches the whole thing
    // greedily but there's no whitespace boundary, so no hit.
    it('does NOT autolink when trailing punctuation runs into more URL-shape characters', () => {
      const hits = findCompletedHits('https://example.com.https://second.com', URL_RE, id);
      expect(hits).toEqual([]);
    });

    // treatEndAsBoundary + trailing punct at end of text: the
    // boundary lives PAST the stripped period, so cursorPos must be
    // past it too. Caret just after the period → fires; caret on
    // the period → declines.
    it('end-of-text URL with trailing punct fires under treatEndAsBoundary when caret is past', () => {
      const hits = findCompletedHits('https://example.com.', URL_RE, id, {
        treatEndAsBoundary: true,
        nodeStart: 0,
        cursorPos: 21, // strictly past the period at index 19, boundary at 20
      });
      expect(hits).toEqual([{ index: 0, length: 19, href: 'https://example.com' }]);
    });

    it('end-of-text URL with trailing punct declines under treatEndAsBoundary when caret is on the boundary', () => {
      const hits = findCompletedHits('https://example.com.', URL_RE, id, {
        treatEndAsBoundary: true,
        nodeStart: 0,
        cursorPos: 20, // caret exactly on the boundary — NOT past
      });
      expect(hits).toEqual([]);
    });

    // WWW_URL_RE: the boundary fix benefits this regex too — but only
    // when the optional path group consumed trailing punct that gets
    // stripped. Hostname-only WWW URLs (`www.example.com.`) don't
    // trigger the fix because the regex's `\b`-equivalent stops at the
    // domain boundary before any punct can enter the match.
    it('autolinks www.X with path + trailing period + space (RAISE-66 cross-regex)', () => {
      const hits = findCompletedHits(
        'www.example.com/path. ok',
        WWW_URL_RE,
        (m) => `http://${m}`,
      );
      expect(hits).toEqual([
        { index: 0, length: 20, href: 'http://www.example.com/path' },
      ]);
    });

    // BARE_HOSTNAME_RE regression pin: the fix MUST NOT enable
    // autolinking for `example.com. ok` because BARE_HOSTNAME_RE
    // stops at the `\b` after `com` — the trailing `.` was never
    // inside the match, no punct gets stripped, and the boundary at
    // position 11 is still the unstripped `.`, not whitespace. The
    // RAISE-66 fix is a no-op here; this test pins that.
    it('does NOT autolink bare hostname followed by trailing period + space (regression pin)', () => {
      const hits = findCompletedHits('example.com. ok', BARE_HOSTNAME_RE, (m) => `http://${m}`, {
        requireKnownTld: true,
      });
      expect(hits).toEqual([]);
    });

    // EMAIL_RE regression pin: same reasoning as BARE_HOSTNAME_RE —
    // the email regex's domain ends at `[\w-]+`, so trailing punct
    // is never inside the match. RAISE-66 doesn't apply, declines
    // for the same word-boundary reason.
    it('does NOT autolink email followed by trailing period + space (regression pin)', () => {
      const hits = findCompletedHits('a@example.com. ok', EMAIL_RE, (m) => `mailto:${m}`);
      expect(hits).toEqual([]);
    });

    // Degenerate URL whose entire post-scheme body is trailing punct.
    // URL_RE accepts `https://...` (the `+` after `://` matches the
    // three periods); TRAILING_PUNCT_RE then strips `...` leaving
    // `https://` — which doesn't satisfy URL_RE anymore. The
    // defensive `verifyRe.exec(trimmed)` guard added alongside the
    // boundary fix rejects this case; without it we'd anchor a
    // broken `href: 'https://'` here.
    it('does NOT autolink a scheme-only URL whose body got stripped to punct', () => {
      const hits = findCompletedHits('https://... ok', URL_RE, id);
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

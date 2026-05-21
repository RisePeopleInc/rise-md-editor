// Smoke + regression test for the filename / TLD autolink gate
// (RAISE-14 — first test under the new vitest infra; covers logic
// that originally landed in RAISE-47).
//
// `looksLikeFilenameExtension` is the discriminator that gates
// autolink behaviour across the editor: a `file.md` reference in a
// markdown note must NOT become a link to host `file.md`, while
// `www.cbc.ca` SHOULD autolink. The function feeds into multiple
// surfaces (remark-gfm rewriter, autolink-on-type plugin, paste
// pipeline) — false positives or negatives here ripple everywhere.
//
// This file deliberately tests a few real edge cases (scheme strip,
// path strip, case-insensitivity, the bare-hostname positive case)
// rather than enumerating every entry in the list. The list itself
// is data; the function is logic.
import { describe, expect, it } from 'vitest';
import { looksLikeFilenameExtension, looksLikeKnownTld } from '../filenameExtensions';

describe('looksLikeFilenameExtension', () => {
  it('flags common file-extension references as filenames', () => {
    expect(looksLikeFilenameExtension('file.md')).toBe(true);
    expect(looksLikeFilenameExtension('notes.txt')).toBe(true);
    expect(looksLikeFilenameExtension('config.yaml')).toBe(true);
    expect(looksLikeFilenameExtension('archive.tar.gz')).toBe(true);
  });

  it('does not flag bare-domain URLs as filenames', () => {
    // The classic regression: `www.cbc.ca` ends in `ca`, which is
    // a real country TLD and must stay autolinkable.
    expect(looksLikeFilenameExtension('www.cbc.ca')).toBe(false);
    expect(looksLikeFilenameExtension('example.com')).toBe(false);
    expect(looksLikeFilenameExtension('rise.io')).toBe(false);
  });

  it('strips scheme + path/query/fragment before checking the suffix', () => {
    // The discriminator runs against the host portion only; a bogus
    // path tacked on to a filename reference still reads as a file.
    expect(looksLikeFilenameExtension('http://file.md')).toBe(true);
    expect(looksLikeFilenameExtension('https://file.md/path')).toBe(true);
    expect(looksLikeFilenameExtension('file.md?x=1')).toBe(true);
    expect(looksLikeFilenameExtension('file.md#section')).toBe(true);
    // And the inverse: a URL with a path is judged on its HOST,
    // not the path tail. `example.com/file.md` checks the `.com`
    // suffix and stays a URL, even though the path looks like a
    // markdown filename.
    expect(looksLikeFilenameExtension('https://example.com/file.md')).toBe(false);
    expect(looksLikeFilenameExtension('https://example.com/path')).toBe(false);
  });

  it('is case-insensitive on the extension', () => {
    expect(looksLikeFilenameExtension('README.MD')).toBe(true);
    expect(looksLikeFilenameExtension('Photo.JPG')).toBe(true);
  });

  it('returns false for text with no dot or with an empty suffix', () => {
    expect(looksLikeFilenameExtension('justaword')).toBe(false);
    expect(looksLikeFilenameExtension('trailing.')).toBe(false);
    expect(looksLikeFilenameExtension('')).toBe(false);
  });
});

describe('looksLikeKnownTld', () => {
  it('flags real TLDs', () => {
    expect(looksLikeKnownTld('example.com')).toBe(true);
    expect(looksLikeKnownTld('www.cbc.ca')).toBe(true);
    expect(looksLikeKnownTld('rise.io')).toBe(true);
  });

  it('does not flag natural-language abbreviation patterns', () => {
    // The original RAISE-47 regression: `e.g.something` matched the
    // autolink-on-type regex but its `something` suffix is not a
    // TLD, so we must NOT classify it as a known-TLD host.
    expect(looksLikeKnownTld('e.g.something')).toBe(false);
    expect(looksLikeKnownTld('i.e.foobar')).toBe(false);
  });

  it('does not flag file-extension references', () => {
    expect(looksLikeKnownTld('file.md')).toBe(false);
    expect(looksLikeKnownTld('photo.png')).toBe(false);
  });
});

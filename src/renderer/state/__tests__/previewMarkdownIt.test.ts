// Behaviour lock for the shared preview markdown-it builder (RAISE-61).
//
// The three preview surfaces (SplitView, ReadView, PDF/HTML export) used to
// each construct their own near-identical markdown-it instance; this suite
// pins the consolidated `buildPreviewMarkdownIt` so the extraction stays
// byte-for-byte faithful and future tweaks don't silently regress one knob.
// markdown-it is pure string -> string, so no DOM / jsdom is needed.
import { describe, expect, it } from 'vitest';
import { buildPreviewMarkdownIt } from '../previewMarkdownIt';

// Identity resolver for the cases that don't care about image rewriting.
const identity = (src: string) => src;

describe('buildPreviewMarkdownIt', () => {
  describe('task lists', () => {
    it('renders interactive (non-disabled) checkboxes when taskListsEnabled is true', () => {
      const md = buildPreviewMarkdownIt({ taskListsEnabled: true, imageSrcResolver: identity });
      const html = md.render('- [ ] todo\n- [x] done');
      expect(html).toContain('type="checkbox"');
      expect(html).not.toContain('disabled');
    });

    it('renders static (disabled) checkboxes when taskListsEnabled is false', () => {
      const md = buildPreviewMarkdownIt({ taskListsEnabled: false, imageSrcResolver: identity });
      const html = md.render('- [ ] todo\n- [x] done');
      expect(html).toContain('type="checkbox"');
      expect(html).toContain('disabled');
    });
  });

  describe('RAISE-47 filename-shaped autolink suppression', () => {
    it('unwraps a link whose href is a filename-shaped suffix', () => {
      const md = buildPreviewMarkdownIt({ taskListsEnabled: true, imageSrcResolver: identity });
      const html = md.render('see [notes](notes.txt) and [spec](spec.md)');
      // The visible text survives, but no anchor is emitted for file-shaped hrefs.
      expect(html).toContain('notes');
      expect(html).toContain('spec');
      expect(html).not.toContain('<a');
      expect(html).not.toContain('href="notes.txt"');
    });

    it('keeps real explicit-scheme links and bare-domain autolinks', () => {
      const md = buildPreviewMarkdownIt({ taskListsEnabled: true, imageSrcResolver: identity });
      const explicit = md.render('[site](https://example.com)');
      expect(explicit).toContain('<a');
      expect(explicit).toContain('href="https://example.com"');
      // linkify keeps fuzzyLink so a real bare hostname still autolinks.
      const bare = md.render('visit www.cbc.ca today');
      expect(bare).toContain('<a');
    });
  });

  describe('plugins', () => {
    it('renders GitHub emoji shortcodes (markdown-it-emoji full set)', () => {
      const md = buildPreviewMarkdownIt({ taskListsEnabled: true, imageSrcResolver: identity });
      expect(md.render(':fire:')).toContain('🔥');
    });

    it('greys out review-style comments (markdownItComments)', () => {
      const md = buildPreviewMarkdownIt({ taskListsEnabled: true, imageSrcResolver: identity });
      expect(md.render('text <!-- hidden note --> more')).toContain('md-comment');
    });
  });

  describe('image-src resolver', () => {
    it('rewrites the image src through the provided resolver', () => {
      const md = buildPreviewMarkdownIt({
        taskListsEnabled: true,
        imageSrcResolver: (src) => `resolved://${src}`,
      });
      const html = md.render('![alt](assets/foo.png)');
      expect(html).toContain('src="resolved://assets/foo.png"');
      expect(html).not.toContain('src="assets/foo.png"');
    });

    it('escapes raw HTML (html: false)', () => {
      const md = buildPreviewMarkdownIt({ taskListsEnabled: true, imageSrcResolver: identity });
      expect(md.render('<script>alert(1)</script>')).not.toContain('<script>');
    });
  });
});

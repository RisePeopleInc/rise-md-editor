// RAISE-85: unit tests for the shared task-list checkbox toggle helper.
// The toggle math (flip `[ ]` <-> `[x]` on a single source line, keyed
// by an absolute source-line index) backs both SplitView's preview pane
// and ReadView's now-clickable checkboxes. Bugs here corrupt the user's
// file on every click, so the marker flip, the no-op cases, and the
// "compose rapid toggles from the latest content" sequence all get
// coverage.

import { describe, expect, it } from 'vitest';
import { toggleTaskLine, TASK_LINE_MARKER_RE } from '../taskListToggle';

describe('toggleTaskLine', () => {
  it('flips an unchecked box to checked', () => {
    const src = '# Todo\n\n- [ ] buy milk\n- [ ] walk dog\n';
    // line 2 (0-indexed) is `- [ ] buy milk`
    expect(toggleTaskLine(src, 2)).toBe('# Todo\n\n- [x] buy milk\n- [ ] walk dog\n');
  });

  it('flips a checked box back to unchecked', () => {
    const src = '- [x] done\n';
    expect(toggleTaskLine(src, 0)).toBe('- [ ] done\n');
  });

  it('treats an uppercase [X] as checked and unchecks it', () => {
    const src = '- [X] done\n';
    expect(toggleTaskLine(src, 0)).toBe('- [ ] done\n');
  });

  it('only touches the targeted line, leaving siblings untouched', () => {
    const src = '- [ ] a\n- [ ] b\n- [ ] c\n';
    expect(toggleTaskLine(src, 1)).toBe('- [ ] a\n- [x] b\n- [ ] c\n');
  });

  it('returns the input unchanged for an out-of-range line index', () => {
    const src = '- [ ] a\n';
    expect(toggleTaskLine(src, 5)).toBe(src);
  });

  it('returns the input unchanged when the target line has no marker', () => {
    const src = '# Heading\n- [ ] a\n';
    expect(toggleTaskLine(src, 0)).toBe(src);
  });

  it('composes sequential toggles from the latest content (rapid clicks)', () => {
    // Simulates two fast clicks on the same checkbox: each toggle must
    // be computed from the result of the previous one, not the original.
    const src = '- [ ] task\n';
    const once = toggleTaskLine(src, 0);
    expect(once).toBe('- [x] task\n');
    const twice = toggleTaskLine(once, 0);
    expect(twice).toBe('- [ ] task\n');
  });

  it('preserves frontmatter offset positioning (absolute line index)', () => {
    // Frontmatter occupies lines 0-3; the task item is at absolute line 5.
    const src = '---\ntitle: x\n---\n\n# H\n- [ ] task\n';
    expect(toggleTaskLine(src, 5)).toBe('---\ntitle: x\n---\n\n# H\n- [x] task\n');
  });
});

describe('TASK_LINE_MARKER_RE', () => {
  it('matches an unchecked marker', () => {
    expect('- [ ] x'.match(TASK_LINE_MARKER_RE)?.[1]).toBe(' ');
  });
  it('matches a checked marker', () => {
    expect('- [x] x'.match(TASK_LINE_MARKER_RE)?.[1]).toBe('x');
  });
});

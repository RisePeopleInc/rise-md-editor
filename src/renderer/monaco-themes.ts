import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

/**
 * Gruvbox theme registration for Monaco. Six variants — three contrast
 * levels (hard / medium / soft) × two modes (light / dark) — that give
 * developers a clearly differentiated source-editing surface vs. the
 * Rise-branded WYSIWYG / preview / chrome zones.
 *
 * Editor preferences are decoupled from the app theme: the user can
 * lock the editor to dark while the WYSIWYG follows the OS, or pick a
 * softer contrast for late-night editing without affecting the rest of
 * the UI.
 *
 * Palettes are hardcoded JS constants rather than CSS variables — the
 * values never change at runtime (they're brand-Gruvbox), and reading
 * via `getComputedStyle` was racing the stylesheet load on the first
 * paint.
 */

export type EditorContrast = 'hard' | 'medium' | 'soft';
export type EditorMode = 'light' | 'dark';

interface GruvboxPalette {
  bg: string;
  bg1: string;
  bg2: string;
  fg: string;
  fg1: string;
}

/** The bg / fg ramps differ by contrast level; everything else is shared. */
const PALETTES: Record<EditorContrast, Record<EditorMode, GruvboxPalette>> = {
  hard: {
    dark: {
      bg: '#1d2021',
      bg1: '#3c3836',
      bg2: '#504945',
      fg: '#fbf1c7',
      fg1: '#ebdbb2',
    },
    light: {
      bg: '#f9f5d7',
      bg1: '#ebdbb2',
      bg2: '#d5c4a1',
      fg: '#3c3836',
      fg1: '#504945',
    },
  },
  medium: {
    dark: {
      bg: '#282828',
      bg1: '#3c3836',
      bg2: '#504945',
      fg: '#ebdbb2',
      fg1: '#d5c4a1',
    },
    light: {
      bg: '#fbf1c7',
      bg1: '#ebdbb2',
      bg2: '#d5c4a1',
      fg: '#3c3836',
      fg1: '#504945',
    },
  },
  soft: {
    dark: {
      bg: '#32302f',
      bg1: '#3c3836',
      bg2: '#504945',
      fg: '#ebdbb2',
      fg1: '#d5c4a1',
    },
    light: {
      bg: '#f2e5bc',
      bg1: '#ebdbb2',
      bg2: '#d5c4a1',
      fg: '#3c3836',
      fg1: '#504945',
    },
  },
};

/** Accent colors — same across every contrast level. */
const ACCENT = {
  gray: '#928374',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  purple: '#b16286',
  aqua: '#689d6a',
  orange: '#d65d0e',
} as const;

/** Stable theme id for a given (contrast, mode) pair. */
export function gruvboxThemeId(contrast: EditorContrast, mode: EditorMode): string {
  return `gruvbox-${contrast}-${mode}`;
}

/**
 * Token-color map per the RAISE-10 brief:
 *   red    keywords / headings
 *   green  strings / bold
 *   yellow types / italic
 *   blue   functions / links
 *   purple constants / variables (markdown variables)
 *   aqua   types / inline code / tags
 *   orange numbers
 *   gray   comments / line numbers
 */
function buildTheme(
  contrast: EditorContrast,
  mode: EditorMode,
): monaco.editor.IStandaloneThemeData {
  const p = PALETTES[contrast][mode];
  const stripHash = (hex: string): string => hex.slice(1);
  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      // Markdown / generic source tokens
      { token: 'keyword', foreground: stripHash(ACCENT.red) },
      { token: 'keyword.md', foreground: stripHash(ACCENT.red), fontStyle: 'bold' },
      { token: 'string', foreground: stripHash(ACCENT.green) },
      { token: 'string.md', foreground: stripHash(ACCENT.green) },
      { token: 'comment', foreground: stripHash(ACCENT.gray), fontStyle: 'italic' },
      { token: 'number', foreground: stripHash(ACCENT.orange) },
      { token: 'type', foreground: stripHash(ACCENT.yellow) },
      { token: 'class', foreground: stripHash(ACCENT.yellow) },
      { token: 'function', foreground: stripHash(ACCENT.blue) },
      { token: 'variable', foreground: stripHash(p.fg) },
      { token: 'variable.md', foreground: stripHash(ACCENT.purple) },
      { token: 'constant', foreground: stripHash(ACCENT.purple) },
      { token: 'tag', foreground: stripHash(ACCENT.aqua) },

      // Markdown-specific
      { token: 'metatag.html', foreground: stripHash(ACCENT.aqua) },
      { token: 'string.link.md', foreground: stripHash(ACCENT.blue) },
      { token: 'string.link.title.md', foreground: stripHash(ACCENT.blue) },
      { token: 'emphasis', foreground: stripHash(ACCENT.yellow), fontStyle: 'italic' },
      { token: 'strong', foreground: stripHash(ACCENT.green), fontStyle: 'bold' },
    ],
    colors: {
      // Core editor surfaces
      'editor.background': p.bg,
      'editor.foreground': p.fg,
      'editorLineNumber.foreground': ACCENT.gray,
      'editorLineNumber.activeForeground': p.fg1,
      'editor.lineHighlightBackground': p.bg1,
      'editor.lineHighlightBorder': p.bg1,
      'editorCursor.foreground': ACCENT.orange,
      'editor.selectionBackground': p.bg2,
      'editor.inactiveSelectionBackground': p.bg1,
      'editor.findMatchBackground': `${ACCENT.yellow}66`,
      'editor.findMatchHighlightBackground': `${ACCENT.yellow}33`,

      // Gutter
      'editorGutter.background': p.bg,

      // Whitespace + indent guides
      'editorWhitespace.foreground': p.bg2,
      'editorIndentGuide.background': p.bg1,
      'editorIndentGuide.activeBackground': p.bg2,

      // Scrollbar
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': `${p.bg2}80`,
      'scrollbarSlider.hoverBackground': `${p.bg2}cc`,
      'scrollbarSlider.activeBackground': p.bg2,

      // Suggest widgets / find widget
      'editorWidget.background': p.bg1,
      'editorWidget.border': p.bg2,
      'editorSuggestWidget.background': p.bg1,
      'editorSuggestWidget.border': p.bg2,
      'editorSuggestWidget.foreground': p.fg,
      'editorSuggestWidget.selectedBackground': p.bg2,
    },
  };
}

let registered = false;

/**
 * Register all 6 Gruvbox variants up front. Each `defineTheme` call is
 * cheap (just stores the theme dict), and registering eagerly means any
 * subsequent `monaco.editor.setTheme(id)` is guaranteed to find the
 * matching definition. Idempotent.
 */
export function registerAllGruvboxThemes(): void {
  if (registered) return;
  registered = true;
  const contrasts: EditorContrast[] = ['hard', 'medium', 'soft'];
  const modes: EditorMode[] = ['light', 'dark'];
  for (const contrast of contrasts) {
    for (const mode of modes) {
      monaco.editor.defineTheme(
        gruvboxThemeId(contrast, mode),
        buildTheme(contrast, mode),
      );
    }
  }
}

import * as monaco from 'monaco-editor';

/**
 * Gruvbox theme registration for Monaco. Two themes — one for each app
 * theme — that give developers a clearly differentiated source-editing
 * surface vs. the Rise-branded WYSIWYG / preview / chrome zones.
 *
 * Color values are read from the `--gruvbox-*` CSS variables in
 * themes.css so the palette stays in one place. We snapshot the values
 * at theme-define time rather than wiring up reactive CSS-var lookups
 * inside Monaco — Monaco's color tokens are static once registered, so
 * we re-define the themes whenever the data-theme attribute swaps.
 */

export const GRUVBOX_LIGHT_ID = 'gruvbox-light';
export const GRUVBOX_DARK_ID = 'gruvbox-dark';

// Keep the variable names list-shaped so the snapshot helper doesn't
// drift when we add another color.
const GRUVBOX_VARS = [
  '--gruvbox-bg',
  '--gruvbox-bg1',
  '--gruvbox-bg2',
  '--gruvbox-fg',
  '--gruvbox-fg1',
  '--gruvbox-gray',
  '--gruvbox-red',
  '--gruvbox-green',
  '--gruvbox-yellow',
  '--gruvbox-blue',
  '--gruvbox-purple',
  '--gruvbox-aqua',
  '--gruvbox-orange',
] as const;
type GruvboxVar = (typeof GRUVBOX_VARS)[number];
type GruvboxPalette = Record<GruvboxVar, string>;

function readPalette(themeAttr: 'light' | 'dark'): GruvboxPalette {
  // Read against an off-screen probe element with the requested data-theme
  // so we get the variant's resolved values regardless of what the
  // document is currently set to. Avoids "you registered the dark theme
  // with the light bg colors" if we register both before the user has
  // ever toggled.
  const probe = document.createElement('div');
  probe.setAttribute('data-theme', themeAttr);
  // Out of flow + size-zero so it doesn't repaint the page.
  probe.style.position = 'absolute';
  probe.style.width = '0';
  probe.style.height = '0';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  try {
    const styles = getComputedStyle(probe);
    const out = {} as GruvboxPalette;
    for (const v of GRUVBOX_VARS) {
      const raw = styles.getPropertyValue(v).trim();
      if (!raw) {
        // Fallback to a sensible default rather than throwing — Monaco
        // would refuse to register a theme with empty colors, but a
        // missing var probably means the stylesheet hasn't loaded yet
        // (test/HMR edge cases). #ff00ff is loud enough to be noticed.
        out[v] = '#ff00ff';
      } else {
        out[v] = raw.startsWith('#') ? raw : `#${raw}`;
      }
    }
    return out;
  } finally {
    probe.remove();
  }
}

/**
 * Build a Monaco theme definition from a Gruvbox palette. Token-color
 * mapping follows the spec in the RAISE-10 brief:
 *   red    keywords / headings
 *   green  strings / bold
 *   yellow types / italic
 *   blue   functions / links
 *   purple constants / numbers (for code), used in keyword.other too
 *   aqua   types / inline code
 *   orange numbers (markdown), constants
 *   gray   comments / line numbers
 */
function buildTheme(
  palette: GruvboxPalette,
  base: 'vs' | 'vs-dark',
): monaco.editor.IStandaloneThemeData {
  const c = palette;
  return {
    base,
    inherit: true,
    rules: [
      // Markdown tokens — what the source editor mostly sees.
      { token: 'keyword.md', foreground: c['--gruvbox-red'].slice(1) },
      { token: 'keyword', foreground: c['--gruvbox-red'].slice(1) },
      { token: 'string', foreground: c['--gruvbox-green'].slice(1) },
      { token: 'string.md', foreground: c['--gruvbox-green'].slice(1) },
      { token: 'comment', foreground: c['--gruvbox-gray'].slice(1), fontStyle: 'italic' },
      { token: 'number', foreground: c['--gruvbox-orange'].slice(1) },
      { token: 'type', foreground: c['--gruvbox-yellow'].slice(1) },
      { token: 'class', foreground: c['--gruvbox-yellow'].slice(1) },
      { token: 'function', foreground: c['--gruvbox-blue'].slice(1) },
      { token: 'variable', foreground: c['--gruvbox-fg'].slice(1) },
      { token: 'constant', foreground: c['--gruvbox-purple'].slice(1) },
      { token: 'tag', foreground: c['--gruvbox-aqua'].slice(1) },

      // Markdown-specific highlights
      { token: 'metatag.html', foreground: c['--gruvbox-aqua'].slice(1) },
      { token: 'string.link.md', foreground: c['--gruvbox-blue'].slice(1) },
      { token: 'string.link.title.md', foreground: c['--gruvbox-blue'].slice(1) },
      {
        token: 'keyword.md',
        foreground: c['--gruvbox-red'].slice(1),
        fontStyle: 'bold',
      },
      {
        token: 'emphasis',
        foreground: c['--gruvbox-yellow'].slice(1),
        fontStyle: 'italic',
      },
      {
        token: 'strong',
        foreground: c['--gruvbox-green'].slice(1),
        fontStyle: 'bold',
      },
      { token: 'variable.md', foreground: c['--gruvbox-purple'].slice(1) },
    ],
    colors: {
      // Core editor surfaces
      'editor.background': c['--gruvbox-bg'],
      'editor.foreground': c['--gruvbox-fg'],
      'editorLineNumber.foreground': c['--gruvbox-gray'],
      'editorLineNumber.activeForeground': c['--gruvbox-fg1'],
      'editor.lineHighlightBackground': c['--gruvbox-bg1'],
      'editor.lineHighlightBorder': c['--gruvbox-bg1'],
      'editorCursor.foreground': c['--gruvbox-orange'],
      'editor.selectionBackground': c['--gruvbox-bg2'],
      'editor.inactiveSelectionBackground': c['--gruvbox-bg1'],
      'editor.findMatchBackground': `${c['--gruvbox-yellow']}66`,
      'editor.findMatchHighlightBackground': `${c['--gruvbox-yellow']}33`,

      // Gutter
      'editorGutter.background': c['--gruvbox-bg'],

      // Whitespace + indent guides
      'editorWhitespace.foreground': c['--gruvbox-bg2'],
      'editorIndentGuide.background': c['--gruvbox-bg1'],
      'editorIndentGuide.activeBackground': c['--gruvbox-bg2'],

      // Scrollbar
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': `${c['--gruvbox-bg2']}80`,
      'scrollbarSlider.hoverBackground': `${c['--gruvbox-bg2']}cc`,
      'scrollbarSlider.activeBackground': c['--gruvbox-bg2'],

      // Suggest widgets / find widget
      'editorWidget.background': c['--gruvbox-bg1'],
      'editorWidget.border': c['--gruvbox-bg2'],
      'editorSuggestWidget.background': c['--gruvbox-bg1'],
      'editorSuggestWidget.border': c['--gruvbox-bg2'],
      'editorSuggestWidget.foreground': c['--gruvbox-fg'],
      'editorSuggestWidget.selectedBackground': c['--gruvbox-bg2'],
    },
  };
}

let registered = false;

/**
 * Register both Gruvbox themes. Idempotent — safe to call multiple
 * times; later calls re-snapshot the palette from current CSS so a
 * stylesheet hot-reload picks up.
 */
export function registerGruvboxThemes(): void {
  const lightTheme = buildTheme(readPalette('light'), 'vs');
  const darkTheme = buildTheme(readPalette('dark'), 'vs-dark');
  monaco.editor.defineTheme(GRUVBOX_LIGHT_ID, lightTheme);
  monaco.editor.defineTheme(GRUVBOX_DARK_ID, darkTheme);
  registered = true;
}

/** Returns the Monaco theme id matching the current app theme. */
export function gruvboxThemeFor(appTheme: 'light' | 'dark'): string {
  if (!registered) registerGruvboxThemes();
  return appTheme === 'dark' ? GRUVBOX_DARK_ID : GRUVBOX_LIGHT_ID;
}

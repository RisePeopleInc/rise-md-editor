// `turndown-plugin-gfm` ships no types. Declare just enough for
// our usage — the package exports named plugins that you `.use()`
// on a TurndownService instance.
//
// Lives in its own ambient-only file (no top-level import/export)
// for the same reason markdown-it-task-lists.d.ts does (RAISE-29 /
// RAISE-31): putting `declare module` in env.d.ts gets it shadowed
// by that file's module classification.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  type Plugin = TurndownService.Plugin;
  export const gfm: Plugin;
  export const tables: Plugin;
  export const strikethrough: Plugin;
  export const taskListItems: Plugin;
  export const highlightedCodeBlock: Plugin;
}

// `markdown-it-task-lists` ships no `.d.ts` (RAISE-29). Declare just
// enough for our usage — it's a default-exported markdown-it plugin
// function.
//
// Kept in its own ambient-only file (no top-level `import` /
// `export`) so `declare module` is unambiguously ambient and
// resolves before `import markdownItTaskLists from
// 'markdown-it-task-lists'` in `SplitView.tsx`. The same
// declaration in `env.d.ts` was being shadowed by that file's
// module classification (it has top-level `export type` /
// `export interface` declarations, which makes the whole file a
// module rather than an ambient script).
declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  interface TaskListsOptions {
    /** When true the rendered checkboxes are NOT disabled (interactive). */
    enabled?: boolean;
    /** When true, wraps the item text in a `<label>` for the checkbox. */
    label?: boolean;
    /** When true, places the label after the checkbox instead of around it. */
    labelAfter?: boolean;
  }
  const plugin: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default plugin;
}

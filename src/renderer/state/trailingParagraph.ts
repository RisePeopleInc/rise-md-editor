import { Plugin } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';

/**
 * Ensure there's always an empty paragraph after a trailing code
 * block ([RAISE-36](https://risepeople.atlassian.net/browse/RAISE-36)).
 *
 * The bug: in WYSIWYG mode, a fenced code block created at the end
 * of the document traps the cursor. ProseMirror's natural arrow-key
 * navigation can't move past it because there's no block below to
 * move into; clicking below doesn't register a position because
 * there's nothing to click on; and although the prosemirror
 * `baseKeymap` binds `Mod-Enter` to `exitCode`, in practice users
 * don't discover it (and the keystroke is unintuitive — the
 * convention in most other markdown editors is "click below" or
 * "Down arrow"). The user's only escape is to switch to source
 * mode, edit there, and switch back. Suboptimal.
 *
 * The fix: a ProseMirror `appendTransaction` that watches for
 * doc changes and, if the last child of the doc is a "trapping"
 * block (currently just `code_block`, but easily extended to
 * tables, blockquotes, etc., as more cases are reported), appends
 * a fresh empty paragraph at the end. With the trailing paragraph
 * in place, *every* natural navigation works:
 *
 *   - Down arrow at end of code block moves into the paragraph
 *   - Click below the code block lands on the paragraph
 *   - End / Cmd-End / Ctrl-End jumps to the paragraph
 *   - `Mod-Enter` (via `exitCode`) keeps working as it always did
 *
 * Cost: one extra empty paragraph in the in-memory doc when the
 * "real" content ends with a code block. Serialises to a trailing
 * blank line in source — the kind of thing every reasonable
 * markdown tool emits anyway. On reopen, the parser recreates the
 * empty paragraph from that blank line, so no accumulation.
 *
 * Why an `appendTransaction` plugin specifically: it runs *after*
 * every committed transaction, gets the new state, and can dispatch
 * a follow-up transaction to fix it. That's the standard
 * ProseMirror pattern for invariants that need to be maintained
 * across all doc edits. It's strictly safer than schema-level
 * tricks (no risk of fighting with the paragraph or code-block
 * schemas) and runs once per change, not per render.
 */

const TRAPPING_BLOCK_TYPES = new Set([
  // Code blocks are the headline case from RAISE-36 — fenced ```
  // input rule fires at end of doc, leaves cursor inside the new
  // block, no exit available.
  'code_block',
  // Future candidates as bugs are reported: tables (Milkdown's GFM
  // tables exit via Mod-Enter, but discoverability is the same
  // problem), blockquote, lists with task items at the very end.
  // Add to the set as needed.
]);

export const trailingParagraphPlugin = $prose(
  () =>
    new Plugin({
      appendTransaction: (transactions, _oldState, newState) => {
        // Only run when the doc actually changed. Selection-only
        // transactions don't move blocks around, so the trailing-
        // block invariant can't have shifted.
        if (!transactions.some((tr) => tr.docChanged)) return null;

        const { doc, schema } = newState;
        const lastChild = doc.lastChild;
        if (!lastChild) return null;

        if (!TRAPPING_BLOCK_TYPES.has(lastChild.type.name)) return null;

        const paragraphType = schema.nodes.paragraph;
        if (!paragraphType) return null;

        // Insert an empty paragraph at the very end of the doc.
        // `setMeta('addToHistory', false)` keeps this fix-up out
        // of the user's undo history — undoing past the trailing-
        // paragraph append would be confusing (cursor would jump
        // back into the code block as if by magic).
        return newState.tr
          .insert(doc.content.size, paragraphType.create())
          .setMeta('addToHistory', false);
      },
    }),
);

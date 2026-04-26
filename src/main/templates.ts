// Template content is imported via Vite's `?raw` suffix so the strings
// are inlined into the main bundle at build time. That avoids fs reads
// at runtime and the asar/extraResources juggle that would otherwise be
// needed to ship the .md files alongside the packaged app.
//
// The `?raw` declarations live in `src/main/types.d.ts` so this module
// stays clean.
import claudeTemplate from '../resources/templates/claude-md-template.md?raw';
import skillTemplate from '../resources/templates/skill-md-template.md?raw';

export type TemplateKind = 'claude' | 'skill';

export function getTemplate(kind: TemplateKind): string {
  return kind === 'claude' ? claudeTemplate : skillTemplate;
}

/** Default filename for a freshly-created template file. */
export function defaultFilename(kind: TemplateKind): string {
  return kind === 'claude' ? 'CLAUDE.md' : 'SKILL.md';
}

/** Folder under the workspace root where this template type belongs. */
export function workspaceSubdir(kind: TemplateKind): string | null {
  // CLAUDE.md lives at the workspace root; skill files are namespaced
  // into a `skills/` directory so a workspace can host many skills.
  return kind === 'claude' ? null : 'skills';
}

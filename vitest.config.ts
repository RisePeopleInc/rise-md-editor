// Vitest config for Rise MD Editor (RAISE-14).
//
// Scope: pure-logic unit tests for renderer and main code. NOT for
// React component rendering (no jsdom needed today), NOT for the
// Electron main process running under a real BrowserWindow. Tests
// live next to the source they cover, under a `__tests__` folder:
// `src/renderer/state/__tests__/foo.test.ts` etc.
//
// Vitest re-uses the project's TypeScript + ESM setup via Vite, so
// no extra transpilation config is needed. The `include` glob is
// intentionally narrow to avoid picking up build output or any
// stray fixtures.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    // Default `node` environment is correct for the pure-logic
    // surfaces we test today. Switch on a per-file basis (e.g.
    // `// @vitest-environment jsdom`) if a future test needs DOM.
    environment: 'node',
  },
});

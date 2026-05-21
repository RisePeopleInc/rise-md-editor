import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      'node_modules/**',
      // Git worktrees spawned by Claude Code's Agent tool live under
      // .claude/worktrees/agent-* and contain full copies of the
      // source tree on whatever branch the agent was running. Without
      // this ignore, ESLint walks into them and reports duplicate
      // errors against every file (and even with clean worktrees,
      // they're not "the code we're checking").
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Build-time helper scripts (CommonJS, Node-only). Lives outside
    // src/ so the renderer/main configs above don't pick it up.
    files: ['scripts/**/*.{js,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      // CJS by design — these scripts are invoked by tools that
      // expect a `require`-able module (electron-builder's sign
      // callback is a CommonJS contract).
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
];

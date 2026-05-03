import React from 'react';
import { createRoot } from 'react-dom/client';
import './monaco-setup';
import App from './App';
// Bundled Rise brand fonts ([RAISE-16](https://risepeople.atlassian.net/browse/RAISE-16)).
//
// Replaces the previous Google Fonts <link rel="stylesheet">. Each
// import pulls in a single @font-face declaration with a `url()` ref
// that Vite's asset pipeline rewrites to a hashed path (dev:
// `/@fs/.../*.woff2`; prod: `assets/<font>-<hash>.woff2`) so the woff2
// bytes ship inside the bundle. First paint is fully offline — no
// network round-trip, no fallback flash on cold launch (the welcome
// screen hero "rAIse" rendered briefly in Georgia before swap kicked
// in when the CDN was slow / unreachable).
//
// Latin-only subsets — the app UI is English-only at the moment, so
// the cyrillic / greek / vietnamese / etc. variants in the full
// `@fontsource/<font>/<weight>.css` files would just bloat the bundle
// for unicode-ranges nothing in the app ever renders.
//
// SIL Open Font License obligation: @fontsource ships LICENSE files
// inside each package root (`node_modules/@fontsource/<font>/LICENSE`).
// electron-builder bundles `node_modules` into the asar, so the
// license text travels with the woff2 bytes.
import '@fontsource/open-sans/latin-400.css';
import '@fontsource/open-sans/latin-600.css';
import '@fontsource/open-sans/latin-700.css';
import '@fontsource/source-serif-pro/latin-700.css';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

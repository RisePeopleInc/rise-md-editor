# raise-editor

rAIse — an Electron + React + TypeScript editor scaffold.

## Stack

- **Electron** + **React 19** + **TypeScript** (strict)
- **electron-vite** for bundling with renderer HMR in dev
- **Tailwind CSS 4** via `@tailwindcss/vite`
- **electron-builder** for cross-platform packaging
- **ESLint** (flat config) + **Prettier**

## Requirements

- Node.js **>= 20** (this repo's `engines.node`)
- npm 10+

If you use nvm: `nvm use 22` (any 20+ version works).

## Scripts

| Command            | What it does                                         |
| ------------------ | ---------------------------------------------------- |
| `npm run dev`      | Start the app in dev mode with renderer HMR          |
| `npm run build`    | Type-check + build main, preload, and renderer       |
| `npm run build:mac`| Build macOS distributables (`.dmg`, `.zip`)          |
| `npm run build:win`| Build Windows distributables (`.exe`, `.zip`)        |
| `npm run build:linux` | Build Linux distributables (AppImage, deb)        |
| `npm run lint`     | ESLint over the project                              |
| `npm run format`   | Prettier write across the project                    |

## Project structure

```
src/
  main/       Electron main process (window, menu, IPC handlers)
    index.ts
    menu.ts
  preload/    contextBridge surface exposed to the renderer as window.api
    index.ts
  renderer/   React app
    index.html
    main.tsx
    App.tsx
    components/
    styles/
build/        Packaging assets (icons, entitlements, etc.)
  icon.png    Placeholder app icon — replace with the real artwork
electron-builder.yml
electron.vite.config.ts
```

## Replacing the app icon

The icon is a 1024×1024 placeholder at `build/icon.png`. To swap it in:

1. Drop the new master PNG (or `.icns` / `.ico`) into `build/`.
2. Update the `mac.icon`, `win.icon`, `linux.icon` paths in
   [`electron-builder.yml`](electron-builder.yml) if you renamed the file.

That's the only file that points at the icons.

## Window & menu behavior

- Default window 1200×800, minimum 800×600.
- Title is `rAIse` when no file is open, `filename — rAIse` otherwise.
- Menu sends actions to the renderer over the `menu:action` IPC channel; the
  renderer reacts via `window.api.onMenuAction`. Standard Edit roles (undo,
  redo, cut, copy, paste) are handled natively by Electron.

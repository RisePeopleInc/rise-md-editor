# Brand and trademark notice

The source code in this repository is MIT-licensed (see [`LICENSE`](LICENSE)).
The Rise brand assets shipped alongside it are **not** part of that grant.

## What's reserved

The following are trademarks and brand assets of Rise People Inc., and the MIT
license does not grant you the right to use them:

- **The "Rise" and "Rise People" word marks.**
- **The Rise logo** — the orange (`#FFA31D`) double-ring mark, in any size,
  orientation, or colour variation. The canonical source lives in
  [`build/icon.svg`](build/icon.svg) and the derived rasterizations at
  [`build/icon.png`](build/icon.png) (and the `.icns` / `.ico` files
  electron-builder generates from it).
- **The Rise visual identity** — the design tokens that make a product look
  like a Rise product. The token values are defined in
  [`src/renderer/styles/themes.css`](src/renderer/styles/themes.css) under the
  `--rise-*` custom-property namespace.
- **The product name "Rise MD Editor"** as used to identify this specific
  application.

These are reserved under trademark and unfair-competition law independent of
the source-code license.

## What forks must do

If you fork this repository for a meaningfully different product — i.e.
anything beyond a private patch you build locally — you are required to:

1. **Replace the icon.** Provide your own `build/icon.svg` and `build/icon.png`.
   Do not ship binaries displaying the Rise logo in the dock / start menu /
   About dialog under your own product name.
2. **Replace the product name.** Update `productName` and `appId` in
   [`electron-builder.yml`](electron-builder.yml), the `name` field in
   [`package.json`](package.json), and the window-title / About-dialog strings
   in [`src/main/menu.ts`](src/main/menu.ts) and
   [`src/renderer/index.html`](src/renderer/index.html). Pick a name that is
   not confusable with "Rise" or "Rise People."
3. **Either replace the design tokens or scope them to your own namespace.**
   The `--rise-*` token names are tied to the Rise design system. If you keep
   them as-is and re-skin the values, that's fine for internal experiments
   but should not be redistributed under a third-party product name. For a
   redistributable fork, rename the namespace (e.g. `--myapp-*`).

The `@risepeopleinc/rcl` npm dependency (Rise's internal component library)
is also reserved — it's not currently a direct dep of this repo, but the icon
SVG references it by provenance comment. A fork that pulls it in would be
relying on a separately-licensed Rise package.

## What forks don't have to change

Code that doesn't touch brand surfaces — the editor logic, the Electron
wiring, the IPC channels, the markdown rendering, the file-tree component,
the auto-update plumbing, the build pipeline, etc. — is covered by the MIT
grant and can be reused freely with attribution per the LICENSE.

## Questions

If your use case isn't covered here and you'd like permission to use a
specific Rise mark — for example, integrating Rise MD Editor into a third-
party product offered to Rise customers — contact `legal@risepeople.com`
before shipping.

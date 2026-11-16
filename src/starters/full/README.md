# wseffect full app starter

A complete browser app foundation using the wseffect app layer, code-generated lazy page routing, Vite, and working Themes controls (name input, color Select, and Dialog).

## Requirements and setup

Use Node.js `24.21.0` and pnpm `11.5.0`. The archive includes an independent frozen lockfile and uses only exact public npm package versions; it has no dependency on the wseffect source repository.

```sh
pnpm install --frozen-lockfile
pnpm exec wseffect-codegen .
git init
git add -A
git commit -m "Initialize wseffect app"
pnpm dev
```

Open the local URL printed by Vite. The app Vite plugin needs a build ID for the dev server and production build: the tracked Git source is used by default. In a project without Git metadata, supply `WSEFFECT_BUILD_ID` from your release system for this exact source revision. It must be 7–64 lowercase hexadecimal characters and must not be random or reused for different source:

```sh
WSEFFECT_BUILD_ID="$RELEASE_BUILD_ID" pnpm dev
WSEFFECT_BUILD_ID="$RELEASE_BUILD_ID" pnpm build
```

`RELEASE_BUILD_ID` must already contain a stable identifier such as the source revision/digest assigned by your release process. The app plugin intentionally fails when it cannot derive or receive a build ID; do not add a random fallback.

## Project structure

- `src/main.ts`: app lifecycle and lazy route dispatch.
- `src/pages/home.ts`: interactive page; page folders contain `package.json` with `sideEffects: false` for safe lazy imports.
- `src/pages.gen.ts`: generated route registry; regenerate after editing page files.
- `vite.config.ts`: wseffect app Vite integration (`pwa: false`; version polling is still active).

The app package declares Vite `8.3.4` and `vite-plugin-pwa` `2.0.0` as peers. The plugin peer is installed explicitly even though this starter disables service-worker registration.

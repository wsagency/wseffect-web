# wseffect minimal starter

A small, direct Foldkit Runtime app. It keeps the application lifecycle in one `Model` / `Message` / `update` / `view` module and includes a working counter.

## Requirements

Node.js `24.21.0` and pnpm `11.5.0`. This project is standalone: install dependencies from the npm registry with `pnpm install --frozen-lockfile`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the local URL printed by Vite. Build production output with `pnpm build`; run `pnpm typecheck` to check the TypeScript source. The standalone `foldkit()` plugin does not derive an ID from Git or read `WSEFFECT_BUILD_ID`. To set its public deployment identity, use `FOLDKIT_BUILD_ID` or the plugin's `buildId` option. Change that identity when the deployment's rendering inputs change; it is public metadata, not a secret.

## Files

- `src/main.ts`: direct Foldkit Runtime counter.
- `vite.config.ts`: Foldkit Vite plugin.
- `src/styles.css`: small app-specific layout; Themes supplies component styles.

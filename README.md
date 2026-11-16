# wseffect-web

Separate Astro documentation site for the published wseffect packages. Documentation and starters consume exact registry releases, never the library workspace or local package archives.

## Local commands

Use Node 24.21.0 and pnpm 11.5.0, as pinned by `.node-version` and `packageManager`.

```sh
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm install --frozen-lockfile
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm dev
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm build
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm preview
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm exec playwright install chromium firefox webkit
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm check
```

`pnpm generate` derives the export inventory, Props tables, starter downloads and API references from installed public packages. `pnpm build` generates these inputs, emits the static site to `out/`, then creates Markdown twins, release metadata and the Pagefind search index. Use a production build to exercise search.

`pnpm check` builds the site, validates exports, schemas, links and executable documentation snippets, runs behavioral tests, independently installs and builds the actual starter downloads, and checks Chromium, Firefox, WebKit and accessibility through the local Worker.

Release metadata requires a real Git commit or an explicitly supplied full commit SHA via `SOURCE_SHA`. An unborn checkout cannot produce release metadata implicitly. Temporary acceptance artifacts belong under `$HOME/.cache/wseffect-work`.

The root manifest pins all five wseffect packages to registry version `0.1.0-rc.1`; there are no workspace packages or local package sources. TypeScript is pinned to 7.0.2, matching the library's compiler baseline. Wrangler serves the static-assets Worker; the documentation site has no service worker or PWA manifest. Cloudflare deployment is a separate authorized operation, not part of local checks.

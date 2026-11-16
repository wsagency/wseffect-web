# Website release and deployment

This runbook describes the local deployment tooling for the static Astro site and `wseffect-web` Cloudflare Worker. **It does not claim that the Worker, custom domain, DNS redirect, or website has been deployed.** Read-only discovery found that a Cloudflare Worker script named `wseffect-web` already exists and was unattached to a custom domain at discovery time; its deployed version and configuration are not part of this repository's source of truth. Before any production deployment, inspect that script's current version and configuration, record the exact rollback target, and obtain explicit owner approval to take over that exact script. Never assume the script is absent or silently overwrite it. If the owner chooses a different script name, its deployment target must be intentionally changed and reviewed before using this runbook. Worker adoption/first authorized publish, `wseffect.com` custom-domain setup, `www` DNS/301 configuration, and scoped-token provisioning remain separately owner-authorized external operations.

The deploy script only operates from a clean local `main` exactly matching freshly fetched `origin/main`. It takes an exclusive lock, creates a detached worktree at the guarded full commit SHA under `$HOME/.cache/wseffect-work/release-web/tmp` (override with `WSEFFECT_DEPLOY_TMP` only for an approved external path), performs the install/build/check and artifact gates there, and removes only that run's worktree and lock. It never builds in or removes output from the operator's checkout. Failed gates leave the checkout untouched.

## Local preparation

Use the pinned toolchain and run from the site repository root:

```sh
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm install --frozen-lockfile
mise exec node@24.21.0 pnpm@11.5.0 -- node --test scripts/deploy.test.ts
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm check
```

`pnpm check` is the full site acceptance pipeline: production build, generated inventory/props/routes/snippets checks, unit tests, both downloaded registry starters, and Chromium/Firefox/WebKit plus accessibility. The deploy repeats `pnpm build` and `pnpm check` in the same fresh detached worktree. It sets `WSEFFECT_BUILD_ID` to the validated full `HEAD` SHA for both commands; no fabricated build identifier is used.
Before installation, deploy rejects project-level registry overrides and uses an isolated temporary npm config pinned to `https://registry.npmjs.org/`; it verifies lockfile integrity and the resolved package manifests for all five exact RC.1 dependencies plus Wrangler.

Before deploying, commit and push the intended change to `main`. From that clean, synchronized checkout, run the local validation-only path:

```sh
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm deploy:site -- --dry-run
```

Dry-run performs the guarded checkout, toolchain, registry-pin, build/check, artifact, and retained-asset validations. It does not retrieve a credential, call Wrangler, or make a production HTTP request. Fix any failure in source and repeat from a new clean commit; do not edit the deploy worktree.

## Production deployment inputs and command

The account ID is non-secret and must be configured explicitly from the owner's real Cloudflare account configuration; the script accepts only a 32-character hexadecimal `CLOUDFLARE_ACCOUNT_ID` and never guesses one. The scoped API token is read only after all local gates and an `origin/main` freshness check. After token lookup, the script fetches and checks `origin/main` again immediately before invoking Wrangler:

- Default: libsecret lookup `service=wseffect-web`, `key=CLOUDFLARE_API_TOKEN` via `secret-tool`.
- Optional: set `WSEFFECT_TOKEN_SOURCE=pass` to read the existing `pass` entry `wseffect-web/CLOUDFLARE_API_TOKEN` instead.

Provision the secret through the workstation's approved secret-management process; never paste it into a shell command, export it in the shell, put it in a file, or include it in chat. The token is removed from inherited child environments and is supplied only in the Wrangler process environment. The account ID and optional token-source selector are configuration, not credentials.

After all local gates and the final `origin/main` recheck, the normal deploy also requires `WSEFFECT_DEPLOY_TAKEOVER_APPROVED=yes`. Set it only after the owner has inspected the existing Worker, captured its rollback version, and explicitly approved taking over the named deployment target. Dry-run does not require this acknowledgement.

After those owner approvals and completion of Cloudflare bootstrap, configure the account ID and run:

```sh
export CLOUDFLARE_ACCOUNT_ID='<32-character Cloudflare account ID>'
export WSEFFECT_DEPLOY_TAKEOVER_APPROVED=yes
mise exec node@24.21.0 pnpm@11.5.0 -- pnpm deploy:site
```

The operator should review the commit SHA printed by dry-run and ensure the domain/redirect prerequisites are already owner-approved. Wrangler deploys the pinned `wrangler@4.149.0` Worker with `--message <full-SHA>`. A success receipt containing SHA/version is written outside Git under the release store. The script then performs live HTTP smoke requests for the home and docs pages, `/version.json` SHA, a Markdown twin and HEAD response with `Vary: Accept`, unknown-route and missing-JavaScript 404s, robots/sitemap, a retained hashed asset, and the `www` 301 preserving path/query.

## Retained assets and release store

The external store defaults to `$HOME/.cache/wseffect-work/release-web/releases`; override with `WSEFFECT_RELEASE_STORE` only to select an approved external store. It has this contract:

- `releases.json` contains `{ "releases": ["<newest-first full SHA>", ...] }`.
- Each snapshot is stored at `<store>/<full SHA>/_astro/<hashed asset path>`.
- Before deploy, the shared `mergeRetainedAssets` contract merges current assets with the prior three release snapshots; older release trees are preserved, not deleted.
- Only after Wrangler reports successful publication does deploy store the **pre-retention current build's hashed assets** under its SHA and prepend/deduplicate that SHA in the manifest. Prior releases are not copied into a new SHA snapshot; differing existing asset bytes are rejected, never overwritten.
- `DEFAULT_ASSET_LIMITS` are 19,000 files and 24 MiB per asset. These conservative configured values are the limits checked before deployment; do not raise them without reviewing current Cloudflare plan limits and the shared retention contract.

Do not hand-edit the manifest or delete old release trees as routine cleanup. Keep the store outside every Git worktree and protect it as local deployment state.

## Failure and rollback

Any pre-deploy failure is a stop condition: no Wrangler call should have happened. Correct the cause and repeat from a clean, synchronized `main`; never continue with stale artifacts or reuse a partially modified checkout. An existing lock is treated as another deploy in progress; confirm no deploy process is active before an owner removes a stale lock file.

A Wrangler error or a smoke failure after deployment may leave production partially or fully changed. The script does not automatically roll back because the live state may be unknown. Stop, inspect the actual Cloudflare deployment and HTTP behavior, preserve the recorded SHA/receipt and logs without secrets, and have the owner explicitly choose the rollback target and authorize the rollback. Do not infer rollback state from a local error or redeploy blindly. The www redirect/domain/DNS configuration is separately owner-controlled and is not modified by this script.

# minimatch security remediation — review branch

## Confirmed lockfile dependency paths

The current `pnpm-lock.yaml` contains multiple versions of `minimatch`: `3.1.5`, `5.1.9`, `9.0.9`, and `10.2.6`.

- `@electron/rebuild@4.2.1` depends on `minimatch@9.0.9`.
- `app-builder-lib@26.15.3` depends on `minimatch@10.2.6`.
- Other transitive dependencies use 3.x and 5.x.
- All of these versions are below the patched version `11.0.1` for GHSA-g3hv-75wg-m249.

**This branch does not yet fix the vulnerability.** A forced major-version override may break build tools, so do not modify the lockfile manually or merge before testing.

## Windows reproduction and repair plan

Use a clean Windows checkout of this branch and a Node.js version compatible with the current Electron toolchain:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm why minimatch
pnpm audit
```

Preferred approach: check whether updated versions of `electron-builder`, `@electron/rebuild`, and their upstream dependencies resolve to a patched `minimatch` without major-version overrides. Test a candidate upgrade on this branch and regenerate `pnpm-lock.yaml` using pnpm. If an override is needed, use a *targeted* pnpm override only after confirming the consumer APIs are compatible with minimatch 11.

```powershell
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm why minimatch
pnpm audit
pnpm start
pnpm dist
```

The public review repository does not currently include the Windows icon assets used by `pnpm dist`; supply valid test icons before evaluating the installer build. Verify the generated installer, file selection, document import/export, backups, and offline behavior using synthetic test data.

## Acceptance criteria

- `pnpm-lock.yaml` contains no vulnerable minimatch version for this advisory, or the remaining paths are explicitly documented and justified.
- A clean frozen-lockfile install succeeds.
- Windows app launch and NSIS packaging pass.
- Dependabot alert #5 is resolved by the updated dependency graph, not dismissed.
- No change is made to the original private repository.

Reference: https://github.com/advisories/GHSA-g3hv-75wg-m249

# AGENT.md

This file is for future coding agents working on `timeline-for-bases`.

It is intentionally repo-scoped. Do not add personal machine details, usernames, home directories, vault names, tokens, or other environment-specific configuration here. If you need local paths or vault information, discover them from the current workspace instead of assuming they match a previous machine.

## Purpose

`timeline-for-bases` adds a timeline view to Obsidian Bases with day/week/month/quarter/year scales, editable task bars, grouped views, and inline property editing.

Agents should prefer small, verified changes over broad rewrites. This plugin has a lot of UI behavior that only becomes clear in a live Obsidian session.

## Local Development Conventions

Important:

- Do not hardcode machine-specific paths, vault names, or deployment targets in repo docs or source.
- Discover local verification vaults and plugin install targets from the active workspace.
- After deploying a new build into a live Obsidian environment, reload the app or vault before verifying behavior.

## Build And Test

Primary commands:

```bash
npm test
npm run build
```

Helpful combined flow:

```bash
npm run build
```

Watch mode:

```bash
npm run dev:watch
```

Notes:

- `npm test` runs the lightweight helper test suite from `scripts/test.mjs`.
- `npm run build` runs TypeScript checks and the production bundle.
- Use the repo's local deployment script when the current workspace has one configured.
- `scripts/watch.mjs` builds on change and tries to deploy after successful rebuilds.

## Release Workflow

This repo uses Git tags and GitHub Actions for releases.

Standard release flow:

1. Make sure the worktree is in the intended state.
2. Update `CHANGELOG.md`.
3. Bump the version with one of:
   - `npm version patch`
   - `npm version minor`
   - `npm version major`
4. Push the release commit:
   - `git push origin main`
5. Push the version tag:
   - `git push origin --tags`

Release notes:

- Tags must match Obsidian's required plain `x.y.z` format.
- Do not use a `v` prefix.
- `npm version ...` updates `package.json`, `package-lock.json`, and creates the tag.
- The repo `version` script also updates `manifest.json` and `versions.json`.
- GitHub Actions should publish release assets:
  - `manifest.json`
  - `main.js`
  - `styles.css`
- The release workflow lives in `.github/workflows/release.yml`.

## Architecture Notes

Recent refactors intentionally moved tricky logic into focused helper modules:

- `src/timeline-date.ts`
  Strict day-based parsing and calendar-safe date math.
- `src/timeline-drag.ts`
  Drag and resize range resolution.
- `src/timeline-persistence.ts`
  Scoped per-base/per-view persistence helpers.

Keep new logic near these boundaries instead of adding more complexity back into `src/timeline-view.ts`.

## Behavior Invariants

These are easy to regress and should be preserved unless intentionally redesigned:

- Timeline date semantics are day-based.
  Ignore time-of-day values for rendering and editing.
- Editing a filename-backed primary column should rename the note, not write fake frontmatter.
- The first ordered Bases property is the primary frozen column.
- Group collapse state should persist per base view.
- Time scale should persist per base view.
- Right-click on a bar must not enter drag mode.
- Grouped collapsed views should not leak timeline/grid artifacts between group headers.
- Deployment should be treated as copy-based unless the current workspace explicitly uses a different strategy.

## Verification Expectations

For UI changes:

1. Build the plugin.
2. Deploy the build into the active local test environment when available.
3. Reload the live Obsidian app or vault.
4. Verify behavior in a live Obsidian vault when available.
5. Check for runtime errors after the interaction you changed.

Prefer verifying:

- scale persistence
- grouped collapse/expand persistence
- drag and resize behavior in day view
- click-to-edit behavior for cells
- right-click context menu behavior
- grouped rendering after collapse

## Documentation Guidance

Keep user-facing README content focused on installation, what the plugin does, and user-visible features.

Put agent-oriented workflow notes here instead of expanding the README with contributor-only operational details.

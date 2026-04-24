# Release readiness QA — 2026-04-19

## Scope
Pre-release verification for `timeline-for-bases` after recent border styling / sample updates.
No release was created.

## Automated checks
- `npm test` ✅
- `npm run build` ✅
- static diff scan for secrets / shell injection / eval / pickle / SQL injection ✅ no findings
- independent reviewer subagent ✅ no blocking security or logic defects found

## Live Obsidian verification
Environment:
- desktop Obsidian session on `:0`
- vault: `nexus`
- plugin loaded and enabled
- plugin present in `.obsidian/community-plugins.json`

### QA bases used
- `Timeline Sample/Family Vacation Planning.base`
- `System/PluginTesting/Timeline-Release-QA/Timeline Release QA.base`
- `System/PluginTesting/Timeline-Release-QA/Legacy Timeline QA.base`

### Verified
- timeline plugin loads after full `obsidian reload`
- no runtime errors reported by `obsidian dev:errors`
- sample timeline renders 20 bars
- fill colors render from `priority`
- border colors render from `assigned`
- `Color by` section visible
- `Border by` section visible
- `Border width` control visible inline with `Border by`
- border width persistence works (`2px -> 4px -> reload -> 4px`) and was restored to `2px`
- sample defaults now match the customized `Family Vacation Planning.base` colors
- screenshot captured: `/tmp/timeline-release-qa.png`

## Regression found and fixed during QA
### Legacy timelines without `borderBy`
Issue found:
- bases with no `borderBy` / `borderWidth` were rendering a `2px` neutral border, which changed existing timeline appearance

Fix applied:
- default border width now falls back to `1px` when `borderBy` is unset
- timelines that use border styling still default to `2px`

Post-fix verification:
- legacy QA base renders `1px` neutral border ✅
- border-enabled QA base renders `2px` colored border ✅

## Remaining pre-release tasks
- commit tracked and untracked source/test files
- decide whether `codex_issues.md` should be committed or removed before release
- optionally add a brief changelog entry for dual-property styling / border width / sample improvements

## Current readiness assessment
- code path tested and buildable
- no blocking runtime errors observed
- no blocking security issues found
- suitable for preparing a public release after final cleanup/commit

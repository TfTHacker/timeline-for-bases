# Timeline for Bases

A Gantt-style timeline view for [Obsidian Bases](https://obsidian.md/bases).

---

## The Story

This plugin was 100% vibe coded.

Not in the "throw a prompt at ChatGPT and paste the result" sense — but in the real spirit of it: a casual, back-and-forth conversation over two days between [TfTHacker](https://x.com/tfthacker) and his [OpenClaw](https://openclaw.ai), an AI assistant he has named Nexus.

No design docs written in advance. No architecture meetings. Just a conversation that started with *"I want a timeline view for Bases"* and evolved, one idea at a time, into something genuinely useful.

The plugin was revised continuously throughout the two days — visual polish, UX tweaks, new features, bug fixes — all through natural conversation. TfTHacker would open Obsidian, look at the result, say what felt off, and the next iteration would appear minutes later.

It's what vibe coding looks like when the goal is something real.

---

## What It Does

Timeline for Bases adds a **Gantt-style timeline view** to Obsidian Bases. Point your base at any folder of notes with date frontmatter and you get a horizontal timeline — by day, week, month, quarter, or year.

### Features

- **5 time scales** — Day, Week, Month, Quarter, Year; switch instantly
- **Color by property** — map any frontmatter value to a color from a theme-adaptive palette
- **Label by property** — choose which field appears on each bar
- **Resizable Notes column** — drag to adjust; persisted per view
- **Zoom** — 1× to 5× zoom slider
- **Today marker** — highlighted line for the current date (Day view)
- **Week start** — Monday or Sunday, set in plugin settings
- **Theme-adaptive colors** — all 28 palette colors are Obsidian CSS variables; they shift with your theme automatically
- **Point tasks** — notes with only a start date render as a single-day bar
- **Grouping and sorting** — handled by Bases natively; the timeline respects whatever grouping you've configured

### Configuration (per view)

Set in the Bases **Configure View** panel:
- **Start date** — frontmatter property for the bar start
- **End date** — frontmatter property for the bar end
- **Time scale** — Day / Week / Month / Quarter / Year

Set in the **Config panel** (gear icon in the timeline header):
- **Label** — which property to display on bars
- **Zoom** — scale factor
- **Color by** — property to drive color mapping
- **Color map** — assign colors per unique value

Plugin-wide setting (Settings → Timeline for Bases):
- **Week starts on** — Monday or Sunday

## Install

For testing before the plugin is in the official Obsidian community plugin list, install it with the BRAT plugin:

1. In Obsidian, install and enable **BRAT** ("Beta Reviewers Auto-update Tester").
2. Open **Settings -> BRAT**.
3. Choose **Add Beta plugin**.
4. Paste this repository URL:
   `https://github.com/TfTHacker/timeline-for-bases`
5. Confirm the install and let BRAT download the latest release.
6. Enable **Timeline for Bases** in **Settings -> Community plugins**.

BRAT installs from this repository's GitHub releases, so the tagged release assets must exist for installation to work.

## Releasing

This plugin publishes Obsidian-compatible release assets from a Git tag.

Use this exact flow for a new release:

1. Make sure the working tree is clean:
   `git status`
2. Bump the version:
   `npm version patch`
   or `npm version minor`
   or `npm version major`
3. Push the release commit:
   `git push origin main`
4. Push the tag created by `npm version`:
   `git push origin --tags`
5. GitHub Actions will build the plugin and create a GitHub Release containing:
   - `manifest.json`
   - `main.js`
   - `styles.css`

Notes:

- The Git tag must match the plugin version in `manifest.json` exactly, using Obsidian's required `x.y.z` format.
- Do not use a `v` prefix. Use `0.1.2`, not `v0.1.2`.
- `npm version ...` creates a `vX.Y.Z` tag by default. After running it, replace that tag locally with `X.Y.Z` before pushing.
- `npm version ...` updates `package.json`, `package-lock.json`, and creates the tag.
- The project's `version` script also updates `manifest.json` and `versions.json` automatically.
- The release workflow lives in `.github/workflows/release.yml`.

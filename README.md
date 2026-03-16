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

## Releasing

This plugin publishes Obsidian-compatible release assets from a Git tag.

1. Bump the version:
   `npm version patch`
   or `npm version minor`
   or `npm version major`
2. Push the commit and tag:
   `git push && git push --tags`
3. GitHub Actions will build the plugin and create a GitHub Release containing:
   - `manifest.json`
   - `main.js`
   - `styles.css`

The pushed tag must match the plugin version in `manifest.json`. Tags created by `npm version` like `v0.1.1` are supported.

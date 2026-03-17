# I Vibe Coded an Obsidian Plugin Over Two Days — and It's Actually Good

*By TfTHacker*

---

I've been watching the vibe coding conversation with some skepticism.

Not because AI-assisted development isn't real — it clearly is — but because most of what gets called "vibe coding" is shallow. Paste a prompt, get a component, call it done. The AI writes boilerplate; you tweak it by hand. That's not vibe coding. That's autocomplete with extra steps.

I wanted to test something harder: could a genuinely useful, non-trivial piece of software emerge from a real conversation — no hand-editing, no fallback to "let me just fix this myself"? Could vibe coding produce something I'd actually use?

So I tried it. Over two days, through casual back-and-forth with OpenClaw (an AI assistant running Claude), I built a Gantt-style timeline view for Obsidian Bases. From scratch. Zero lines written by hand.

Here's what happened.

---

## How It Started

I didn't write a spec. I didn't design the architecture. I opened a chat and said: *"I want a timeline view for Obsidian Bases."*

That was it. No mockups. No list of requirements. Just a direction.

What followed was a conversation — the kind you'd have with a developer you trust. We talked about what the view should show, how it should handle missing dates, what "color by property" should look like. Ideas would land, get refined, sometimes get thrown out. The plugin took shape through that process, not before it.

---

## What It Became

By the end of two days, Timeline for Bases had:

- **5 time scales** — Day, Week, Month, Quarter, Year — switchable instantly
- **Auto-fit to data** — no manual date range configuration; the view always fits your tasks
- **Color by property** — map any frontmatter value to a color; 28 theme-adaptive colors built from Obsidian CSS variables via `color-mix()`
- **Label by property** — choose which frontmatter field appears on each bar
- **Resizable Notes column** — drag to adjust, persisted per view
- **Zoom control** — 1× to 5× slider
- **Today marker** in Day view
- **Point tasks** — notes with only a start date render as a single-day bar
- **Week start** (Monday or Sunday) as a global plugin setting
- Full support for Bases grouping and sorting — the timeline respects whatever you've already configured

That's a real feature set. Not a demo. Something I'll open tomorrow and actually use.

---

## What Surprised Me

The quality of the reasoning surprised me most.

When we hit a visual bug — the today marker bleeding behind the sticky Notes column when you scrolled — the fix wasn't just "move it a bit." We talked through *why* it was happening (a canvas-level overlay being overlapped by a sticky element), considered two approaches, and chose the right one: move the today marker into each row's track element so it's contained by the scroll area entirely.

That's not autocomplete. That's architectural thinking.

When the color palette felt limited, we didn't just add more hex values. We discussed what Obsidian actually provides — 8 named color variables, 3 accents, a base scale — and built a 28-color palette using `color-mix()` to generate light and dark variants of each hue. All CSS variables. All theme-adaptive. When you switch from light mode to dark mode, the colors shift with the theme automatically.

Every decision had a reason. And most of the time, the reason was better than what I would have come up with alone.

---

## Was It Perfect?

No. There were bugs. There was one architectural approach — synchronizing scroll position between a split label pane and a timeline pane — that failed halfway through and had to be rebuilt from scratch using CSS sticky positioning instead. That cost half a day.

But that's software development. The difference is the speed. A bug, a rethink, a new implementation — hours, not weeks. The feedback loop between "this looks wrong" and "here's the fix" was tight enough that two full days of iteration felt like genuine progress.

---

## What This Actually Is

I think vibe coding gets a bad reputation because of how it's usually practiced: generate, paste, ship, forget. The output reflects the shallowness of the process.

What I found over these two days is that the quality of the output tracks the quality of the conversation. When I pushed back, explained what I was seeing, asked *why* a decision was made — the results were better. When I just said "fix it" without context, they were worse.

The AI is a collaborator. Like any collaborator, you get out what you put in.

---

## Try It

The plugin is available now:

**GitHub: https://github.com/TfTHacker/timeline-for-bases**

Install manually:
1. Download `main.js`, `styles.css`, and `manifest.json` from the repository
2. Copy them to `<your vault>/.obsidian/plugins/timeline-for-bases/`
3. Enable the plugin in Settings → Community Plugins

Point the view at any folder of notes with `start` and `end` date frontmatter and you have a working timeline.

Please test it. Use it against your real data. Tell me what breaks, what's confusing, what's missing. This is 0.1.0 — there's room to grow, and I'd rather grow it based on actual use than assumptions.

---

*Built with [OpenClaw](https://openclaw.ai). 100% vibe coded.*

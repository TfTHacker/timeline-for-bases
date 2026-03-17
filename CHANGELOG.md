# Changelog

## Unreleased

### Performance
- **Canvas-level grid rendering** — grid lines and today marker are now drawn once on a shared canvas overlay instead of per-row, eliminating ~7,800 DOM nodes on large datasets
- **Entry date caching** — `entryDatesCache` built in a single pass; `entry.getValue()` called at most once per entry per render instead of repeatedly
- **Async chunked rendering** — entry processing and row rendering are deferred in chunks of 50 with browser yields between chunks, keeping the UI responsive during large base loads
- **Metadata cache pre-filter** — when a fixed date window is configured, entries are pre-screened using Obsidian's fast `metadataCache` before any expensive `getValue()` calls; entries clearly outside the window are skipped entirely
- **Debounced data updates** — `onDataUpdated` is debounced 300 ms trailing, preventing redundant re-renders during batch file loads
- **Shared tick computation** — ticks are computed once per render and passed to all rendering functions instead of recomputed per section

### New Features
- **Drag to move tasks** — drag a bar horizontally to shift its start and end dates; frontmatter is updated on release
- **Resize bars** — drag the left or right edge of a bar to adjust the start or end date independently; minimum 1-day width enforced
- **Hover preview** — hovering over a bar or a task label shows Obsidian's native page preview popup; suppressed during drag
- **Day separator lines** — faint vertical lines mark each day column boundary on day scale for easier visual alignment
- **Create Sample Base** — Settings tab button creates a "Timeline Sample" folder with 10 family vacation planning tasks (dated from today) and a ready-to-use base with color-coded priorities (High/Medium/Low)
- **Double-click to open** — double-clicking a bar opens the note; single-clicking a label opens the note; accidental opens after drag are suppressed
- **Span-based axis labels** — month, quarter, and year context headers now fill their full slot width as solid label spans rather than floating point labels
- **Week view tail extension** — auto-fit week view adds 2 extra tail weeks beyond the last task for breathing room

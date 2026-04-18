# Changelog

## 0.1.8

### Persistence Overhaul
- **View-specific settings now persist in the .base file** — color maps, time scale, show/hide colors, column widths, and collapsed groups are all stored directly in the .base view definition alongside native Bases properties. Settings travel with the base file (sync, rename, delete), eliminating orphaned entries and a separate data.json cleanup step.
- **Direct file writes bypass Bases' save pipeline** — Bases' `requestSave()` cycle destroys and recreates the view, causing a white flash. Custom key changes now write directly to the .base file via `vault.modify()`, persisting without flicker.

### Bug Fixes
- **Label column resize now persists** — the first column no longer snaps back to its default width after resize (closes #7).
- **No white flicker on color or column changes** — color palette, column resize, time scale, show/hide colors, and zoom all update smoothly without the view being destroyed and recreated.

## 0.1.7

### New Features
- **Today marker on all time scales** — the red "Today" line and label now appear on Week, Month, Quarter, and Year views, not just Day view (closes #4)

## 0.1.6

### New Features
- **Sticky property columns** — any property you show in Bases can also appear as its own frozen column in the timeline, so you can keep important details visible while scrolling
- **Click-to-edit cells** — editable columns now open directly when clicked, including dates, numbers, checkboxes, text, multitext, and tags
- **Start and end date columns** — the same date fields used for the bars can also be shown as normal columns in the timeline
- **Collapsible groups** — grouped timelines can now be collapsed one section at a time, or all at once with collapse/expand controls in the header
- **Column sorting and reordering** — frozen columns can be reordered by dragging, and sorting can be changed from the timeline headers

### Improvements
- **Closer match to Bases** — the first property in the Bases column order is now used as the main frozen column automatically, with matching property icons, sort indicators, and group header styling
- **Safer date handling** — the timeline now treats dates as calendar days, even when notes store a time, which avoids off-by-one-day problems across time zones
- **Better sample content** — the sample base now creates 20 more realistic project-style tasks instead of the earlier smaller demo set
- **Clearer day view** — day headers now show weekday information more clearly and adapt better when the visible date range gets tight

### Bug Fixes
- **More reliable drag and resize in day view** — bars now snap to the day under your cursor more consistently, including around tricky daylight saving time boundaries
- **Right-click no longer starts dragging** — opening the bar context menu no longer leaves the task moving in the background
- **Filename column edits rename the note correctly** — editing a file-name-based primary column now renames the note instead of creating a fake frontmatter property
- **Delete confirmation** — deleting a note from the bar menu now asks for confirmation first
- **Single-day tasks look correct** — notes with only one day of work now render as a full one-day bar instead of a tiny marker

## 0.1.5

### Improvements
- **Improved sample base** — the "Create sample base" button now generates 20 vacation planning tasks with realistic priorities, parallel task groups, and a clear progression from planning through departure

## 0.1.4

### New Features
- **Draw to create dates** — on rows with no dates, the track area shows a crosshair cursor; click and drag to draw a bar and set the start/end dates directly in the note's frontmatter; respects the date properties configured in the view
- **Clear dates** — right-click any bar → "Clear dates" removes the start and end date from the note's frontmatter; the row returns to dateless state; undoable
- **Drag between groups** — when the view is grouped, a grip handle appears on each row; drag it to any row or group header in another group to reassign the note; frontmatter is updated on drop; undoable
- **Read-only bars for formula dates** — when a date property is a formula or file field, the bar is non-interactive: no drag, resize, or draw; the Edit dates popover disables the relevant input and shows a tooltip explaining why
- **Mobile support** — plugin now works on Obsidian mobile (`isDesktopOnly` removed)

### Bug Fixes
- **Drag to Ungrouped removes property** — dragging a note into the Ungrouped section now deletes the group property from frontmatter instead of setting it to the literal string "Ungrouped"
- **Group drag writes correct frontmatter key** — the `note.` namespace prefix used internally by Bases is now stripped before writing, preventing stale `note.property` keys from being created in the file
- **Drag-to-group works for ungrouped notes** — notes with no group value can now be dragged into a named group; the correct property is inferred from other entries in the view

## 0.1.3

### Performance
Significant rendering improvements were made to reduce DOM overhead, minimize redundant work, and keep the UI responsive with large datasets.

### New Features
- **Drag to move tasks** — drag a bar horizontally to shift its start and end dates; frontmatter is updated on release
- **Resize bars** — drag the left or right edge of a bar to adjust the start or end date independently; minimum 1-day width enforced
- **Hover preview** — hovering over a bar or a task label shows Obsidian's native page preview popup; suppressed during drag
- **Today button** — scrolls the timeline to center today in view
- **Jump to date** — opens a date picker popover to scroll directly to any date
- **Add task** — creates a new note in the same folder as existing entries, pre-filled with today's start/end date, and opens it for editing
- **Export PNG** — captures the current timeline view and saves it as a PNG to the vault root
- **Inline label editing** — a pencil icon appears on row hover; clicking it makes the task name editable inline; Enter saves, Escape cancels
- **Day separator lines** — faint vertical lines mark each day column boundary on day scale for easier visual alignment
- **Create Sample Base** — Settings tab button creates a "Timeline Sample" folder with 10 family vacation planning tasks (dated from today) and a ready-to-use base with color-coded priorities (High/Medium/Low)
- **Right-click context menu** — right-click any bar to open, edit dates, duplicate, or delete the task
- **Multi-select** — Shift+click bars to select multiple; dragging any selected bar moves all of them together by the same delta; Esc clears selection
- **Drag between groups** — when the Bases view is grouped by a property, a grip handle appears on each row; drag it to any row or group header in another group to reassign the note to that group (frontmatter is updated on drop, fully undoable)
- **Draw to create dates** — on rows with no dates, the track area shows a crosshair cursor; click and drag to draw a bar and set the start/end dates directly in the note's frontmatter; respects whatever date properties are configured in the view
- **Clear dates** — right-click any bar → "Clear dates" removes the start and end date from the note's frontmatter; the bar disappears and the row returns to dateless state; undoable
- **Undo / redo** — Ctrl+Z undoes the last drag, resize, or date edit; Ctrl+Y redoes; also available as toolbar buttons; history depth 50
- **Single-click label opens note** — clicking a task label opens the note; double-clicking a bar also opens it; accidental opens after drag are suppressed
- **Span-based axis labels** — month, quarter, and year context headers now fill their full slot width as solid label spans rather than floating point labels
- **Week view tail extension** — auto-fit week view adds 2 extra tail weeks beyond the last task for breathing room

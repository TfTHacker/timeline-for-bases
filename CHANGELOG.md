# Changelog

## Unreleased

### New Features
- **Property columns** — toggle any property visible in Bases and it appears as its own sticky column to the right of the Notes label, with a header in the axis row; columns are resizable by dragging the right edge
- **Property column editing** — hover a row to reveal a pencil icon in each property column; click to edit inline with type-aware controls:
  - **Date / datetime** — floating date picker popover with Save and Clear buttons
  - **Number** — numeric input, saved as a number
  - **Checkbox** — toggles immediately on click
  - **Text / multitext / tags** — inline text input with a suggestions dropdown showing all existing values from the vault, filterable by typing; free text always allowed
- **Start/end date columns** — start and end date properties can now be shown as columns (previously excluded)

### Improvements
- **Delete confirmation** — right-click → Delete now shows a confirmation modal with the note name before moving it to the system trash
- **Single-day tasks** — tasks with only a start date (or same start/end) now render as a full 1-day bar instead of a thin point marker

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

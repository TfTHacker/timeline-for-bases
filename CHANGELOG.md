# Changelog

## Unreleased

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
- **Single-click label opens note** — clicking a task label opens the note; double-clicking a bar also opens it; accidental opens after drag are suppressed
- **Span-based axis labels** — month, quarter, and year context headers now fill their full slot width as solid label spans rather than floating point labels
- **Week view tail extension** — auto-fit week view adds 2 extra tail weeks beyond the last task for breathing room

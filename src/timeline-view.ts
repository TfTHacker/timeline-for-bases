import {
	BasesEntry,
	BasesAllOptions,
	BasesEntryGroup,
	BasesPropertyId,
	BasesPropertyOption,
	BasesView,
	BasesViewConfig,
	DateValue,
	Menu,
	Modal,
	NullValue,
	Notice,
	QueryController,
	Value,
	debounce,
	normalizePath,
	setIcon,
} from 'obsidian';
import type TimelinePlugin from './main';

interface TimelineConfig {
	startDateProp: BasesPropertyId | null;
	endDateProp: BasesPropertyId | null;
	labelProp: BasesPropertyId | null;
	colorProp: BasesPropertyId | null;
	colorMap: Record<string, string>;
	zoom: number;
	timeScale: 'day' | 'week' | 'month' | 'quarter' | 'year';
	weekStart: 'monday' | 'sunday';
	labelColWidth: number;
	/** Raw frontmatter key used for groupBy, if any. Null when not grouped. */
	groupByProp: string | null;
	/** Whether the start/end date properties are writable frontmatter fields (not formulas or file metadata). */
	startWritable: boolean;
	endWritable: boolean;
	/** Ordered list of extra properties to display as columns. */
	extraProps: BasesPropertyId[];
	/** Width (px) for each extra prop column, keyed by JSON.stringify(propId). */
	propColWidths: Record<string, number>;
	/** Total width of the frozen left zone (label col + all prop cols). */
	frozenWidth: number;
}

const LABEL_COLUMN_WIDTH_PX = 175;
const PROP_COLUMN_WIDTH_PX = 110;
const LABEL_COLUMN_MIN_PX = 80;
const LABEL_COLUMN_MAX_PX = 500;

const HUE_VARS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];

const PALETTE: string[] = [
	// Full saturation
	...HUE_VARS.map(h => `var(--color-${h})`),
	// Light tints (mixed with white)
	...HUE_VARS.map(h => `color-mix(in srgb, var(--color-${h}) 55%, white)`),
	// Dark shades (mixed with black)
	...HUE_VARS.map(h => `color-mix(in srgb, var(--color-${h}) 65%, black)`),
	// Accent + grays
	'var(--color-accent)',
	'var(--color-accent-1)',
	'var(--color-base-40)',
	'var(--color-base-60)',
];

const DEFAULT_COLORS = PALETTE;

interface DrawState {
	entryPath: string;
	startKey: string;
	endKey: string;
	anchorDate: Date;       // date at mousedown
	rangeMin: Date;
	totalMs: number;
	trackEl: HTMLElement;   // the track div for this row
	ghostEl: HTMLElement;   // preview bar element
}

interface UndoRecord {
	entries: Array<{
		path: string;
		startKey: string;
		endKey: string;
		before: { start: string; end: string };
		after:  { start: string; end: string };
	}>;
}

interface DragState {
	type: 'move' | 'resize-start' | 'resize-end';
	barEl: HTMLElement;
	entryPath: string;
	startPropKey: string;
	endPropKey: string;
	origStart: Date;        // local midnight
	origEnd: Date;          // local midnight (inclusive)
	mouseStartX: number;
	trackWidth: number;     // px width of track element (for px→% conversion)
	rangeMin: Date;         // local midnight (= timeline min)
	totalMs: number;        // max - min in ms
	// Updated each mousemove — used directly in mouseup to avoid CSS precision loss
	pendingStart: Date;
	pendingEnd: Date;
}

export class TimelineView extends BasesView {
	type = 'timeline';
	containerEl: HTMLElement;
	headerEl: HTMLElement;
	bodyEl: HTMLElement;
	controlsEl: HTMLElement;
	plugin: TimelinePlugin;
	private _renderSeq = 0;

	// Stored after each render for Today/Jump scroll
	private _scrollerEl: HTMLElement | null = null;
	private _rangeMin: Date | null = null;
	private _rangeMax: Date | null = null;
	private _lastConfig: TimelineConfig | null = null;



	// Multi-select
	private _selectedPaths = new Set<string>();

	// Undo / redo
	private _undoStack: UndoRecord[] = [];
	private _redoStack: UndoRecord[] = [];
	private _undoBtn: HTMLButtonElement | null = null;
	private _redoBtn: HTMLButtonElement | null = null;
	private _draw: DrawState | null = null;

	private _dragState: DragState | null = null;
	private _dragTooltipEl: HTMLElement | null = null;
	private _boundMouseMove!: (e: MouseEvent) => void;
	private _boundMouseUp!: (e: MouseEvent) => void;
	private _boundKeyDown!: (e: KeyboardEvent) => void;

	private onResizeDebounce = debounce(() => this.render(), 100, true);
	private onDataDebounce = debounce(() => this.render(), 300, false);

	constructor(controller: QueryController, scrollEl: HTMLElement, plugin: TimelinePlugin) {
		super(controller);
		this.plugin = plugin;
		this.containerEl = scrollEl.createDiv({ cls: 'bases-timeline-view' });
		this.headerEl = this.containerEl.createDiv({ cls: 'bases-timeline-header' });
		this.bodyEl = this.containerEl.createDiv({ cls: 'bases-timeline-body' });
		this.controlsEl = this.containerEl.createDiv({ cls: 'bases-timeline-controls' });
	}

	onload(): void {
		this._boundMouseMove = this._onDragMove.bind(this);
		this._boundMouseUp = this._onDragEnd.bind(this);
		this._boundKeyDown = this._onKeyDown.bind(this);
		document.addEventListener('mousemove', this._boundMouseMove);
		document.addEventListener('mouseup', this._boundMouseUp);
		this.containerEl.addEventListener('keydown', this._boundKeyDown);
		this.containerEl.setAttribute('tabindex', '-1'); // allow keyboard focus
		this.render();
	}

	onunload(): void {
		document.removeEventListener('mousemove', this._boundMouseMove);
		document.removeEventListener('mouseup', this._boundMouseUp);
		this.containerEl.removeEventListener('keydown', this._boundKeyDown);
		this._dragTooltipEl?.remove();
		this.containerEl.empty();
	}

	onResize(): void {
		this.onResizeDebounce();
	}

	onDataUpdated(): void {
		this.onDataDebounce();
	}

	static getViewOptions(_config: BasesViewConfig): BasesAllOptions[] {
		const datePropertyOption = (displayName: string, key: string, placeholder: string): BasesPropertyOption => ({
			displayName,
			type: 'property',
			key,
			filter: (prop: BasesPropertyId) => !prop.startsWith('file.'),
			placeholder,
		});
		const anyPropertyOption = (displayName: string, key: string, placeholder: string): BasesPropertyOption => ({
			displayName,
			type: 'property',
			key,
			placeholder,
		});

		return [
			{
				displayName: 'Fields',
				type: 'group',
				items: [
					datePropertyOption('Start date', 'startDate', 'Property'),
					datePropertyOption('End date', 'endDate', 'Property'),
				]
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [

				]
			},
		];
	}

	private render(): void {
		this.headerEl.empty();
		this.bodyEl.empty();
		this.controlsEl.empty();

		if (!this.data) return;

		const config = this.loadConfig();
		this.containerEl.setAttribute('data-density', 'compact');
		this.containerEl.style.setProperty('--timeline-label-col-width', `${config.labelColWidth}px`);
		this.containerEl.style.setProperty('--timeline-frozen-width', `${config.frozenWidth}px`);
		this.containerEl.style.setProperty('--timeline-prop-col-width', `${PROP_COLUMN_WIDTH_PX}px`);

		this.renderHeader(config);
		this.renderControls(config);
		this.renderTimeline(config);
	}

	private loadConfig(): TimelineConfig {
		const startDateProp = this.config.getAsPropertyId('startDate');
		const endDateProp = this.config.getAsPropertyId('endDate');
		const labelProp = this.config.getAsPropertyId('label');
		const colorProp = this.config.getAsPropertyId('colorBy');
		const colorMap = this.getColorMapFromConfig();
		const zoom = this.getNumericConfig('zoom', 1, 1, 5);
		const timeScale = this.getStringConfig('timeScale', 'week', ['day', 'week', 'month', 'quarter', 'year']) as 'day' | 'week' | 'month' | 'quarter' | 'year';
		const weekStart = this.plugin.settings.defaultWeekStart;
		const labelColWidth = this.getNumericConfig('labelColWidth', LABEL_COLUMN_WIDTH_PX, LABEL_COLUMN_MIN_PX, LABEL_COLUMN_MAX_PX);

		// Read the groupBy property name from the raw Bases config
		const rawConfig = this.config as any;
		const groupByProp: string | null = rawConfig?.groupBy?.property ?? null;

		// A property is writable only if it references a frontmatter field (note.*)
		// Formula and file properties are computed/read-only.
		const isWritable = (prop: BasesPropertyId | null): boolean =>
			prop !== null && String(prop).startsWith('note.');
		const startWritable = isWritable(startDateProp);
		const endWritable   = isWritable(endDateProp);

		// Extra props: user-ordered visible properties, excluding label and color (shown elsewhere)
		// Start/end date props are intentionally NOT excluded — users may want them as columns too
		const excludedProps = new Set(
			[labelProp, colorProp]
				.filter(Boolean)
				.map(p => JSON.stringify(p))
		);
		const extraProps = this.config.getOrder().filter(p => !excludedProps.has(JSON.stringify(p)));

		// Per-prop column widths (persisted in config)
		const savedWidths = (this.config.get('propColWidths') ?? {}) as Record<string, number>;
		const propColWidths: Record<string, number> = {};
		let frozenWidth = labelColWidth;
		for (const prop of extraProps) {
			const key = JSON.stringify(prop);
			const w = typeof savedWidths[key] === 'number' ? savedWidths[key] : PROP_COLUMN_WIDTH_PX;
			propColWidths[key] = w;
			frozenWidth += w;
		}

		return {
			startDateProp,
			endDateProp,
			labelProp,
			colorProp,
			colorMap,
			zoom,
			timeScale,
			weekStart,
			labelColWidth,
			groupByProp,
			startWritable,
			endWritable,
			extraProps,
			propColWidths,
			frozenWidth,
		};
	}

	private getColorMapFromConfig(): Record<string, string> {
		const value = this.config.get('colorMap');
		if (!value || typeof value !== 'object') return {};
		return { ...(value as Record<string, string>) };
	}

	private getControlsVisible(): boolean {
		const value = this.config.get('showColors');
		if (typeof value === 'boolean') return value;
		return true; // default open
	}

	private getNumericConfig(key: string, defaultValue: number, min?: number, max?: number): number {
		const value = this.config.get(key);
		if (value == null || typeof value !== 'number') return defaultValue;

		let result = value;
		if (min !== undefined) result = Math.max(min, result);
		if (max !== undefined) result = Math.min(max, result);
		return result;
	}

	private getStringConfig(key: string, defaultValue: string, allowedValues?: string[]): string {
		const value = this.config.get(key);
		if (value == null || typeof value !== 'string') return defaultValue;
		if (allowedValues && !allowedValues.includes(value)) return defaultValue;
		return value;
	}

	private renderHeader(config: TimelineConfig): void {
		// Left side: view controls
		const leftEl = this.headerEl.createDiv({ cls: 'bases-timeline-header-left' });

		// Time scale selector
		const scaleEl = leftEl.createDiv({ cls: 'bases-timeline-scale-selector' });
		const scaleLabel = scaleEl.createDiv({ cls: 'bases-timeline-scale-label', text: 'Scale:' });
		const scaleButtons = scaleEl.createDiv({ cls: 'bases-timeline-scale-buttons' });
		(['day', 'week', 'month', 'quarter', 'year'] as const).forEach(scale => {
			const btn = scaleButtons.createEl('button', { cls: 'bases-timeline-scale-btn', text: scale.charAt(0).toUpperCase() + scale.slice(1) });
			if (config.timeScale === scale) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				this.config.set('timeScale', scale);
				this.render();
			});
		});



		// Navigation buttons — Today & Jump to date
		const navEl = leftEl.createDiv({ cls: 'bases-timeline-nav-buttons' });

		const todayBtn = navEl.createEl('button', { cls: 'bases-timeline-nav-btn is-icon-only', attr: { 'aria-label': 'Scroll to today' } });
		setIcon(todayBtn, 'locate');
		todayBtn.addEventListener('click', () => this._scrollToDate(new Date()));

		const jumpBtn = navEl.createEl('button', { cls: 'bases-timeline-nav-btn is-icon-only', attr: { 'aria-label': 'Jump to date' } });
		setIcon(jumpBtn, 'calendar');
		jumpBtn.addEventListener('click', (e) => this._showJumpToDate(jumpBtn, e));

		// Right side
		const rightEl = this.headerEl.createDiv({ cls: 'bases-timeline-header-right' });

		// Undo / redo buttons
		const undoBtn = rightEl.createEl('button', { cls: 'bases-timeline-nav-btn is-icon-only', attr: { 'aria-label': 'Undo (Ctrl+Z)' } }) as HTMLButtonElement;
		setIcon(undoBtn, 'undo');
		undoBtn.disabled = this._undoStack.length === 0;
		this._undoBtn = undoBtn;
		undoBtn.addEventListener('click', () => {
			const record = this._undoStack.pop();
			if (!record) return;
			this._redoStack.push(record);
			void this._applyUndoRecord(record, 'undo');
			this._refreshUndoRedoState();
		});

		const redoBtn = rightEl.createEl('button', { cls: 'bases-timeline-nav-btn is-icon-only', attr: { 'aria-label': 'Redo (Ctrl+Y)' } }) as HTMLButtonElement;
		setIcon(redoBtn, 'redo');
		redoBtn.disabled = this._redoStack.length === 0;
		this._redoBtn = redoBtn;
		redoBtn.addEventListener('click', () => {
			const record = this._redoStack.pop();
			if (!record) return;
			this._undoStack.push(record);
			void this._applyUndoRecord(record, 'redo');
			this._refreshUndoRedoState();
		});

		// Separator
		rightEl.createDiv({ cls: 'bases-timeline-nav-sep' });

		// Export PNG button
		const exportBtn = rightEl.createEl('button', { cls: 'bases-timeline-nav-btn is-icon-only', attr: { 'aria-label': 'Export timeline as PNG' } });
		setIcon(exportBtn, 'image');
		exportBtn.addEventListener('click', () => this._exportPng());

		// Separator
		rightEl.createDiv({ cls: 'bases-timeline-nav-sep' });

		// Config toggle
		const toggle = rightEl.createEl('button', { cls: 'bases-timeline-controls-toggle is-icon-only', attr: { 'aria-label': 'Configure colors and display' } });
		setIcon(toggle, 'settings');
		const isVisible = this.getControlsVisible();
		toggle.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
		toggle.addEventListener('click', () => {
			const next = !this.getControlsVisible();
			this.config.set('showColors', next);
			this.render();
		});
	}

	private renderControls(config: TimelineConfig): void {
		const isVisible = this.getControlsVisible();
		this.controlsEl.toggleClass('is-collapsed', !isVisible);
		if (!isVisible) return;

		const allProps = [...(this.allProperties ?? [])].sort((a, b) =>
			this.getPropertyName(a).localeCompare(this.getPropertyName(b))
		);

		// Label property selector
		const labelRowEl = this.controlsEl.createDiv({ cls: 'bases-timeline-config-row' });
		labelRowEl.createSpan({ cls: 'bases-timeline-config-label', text: 'Label:' });
		const labelSelect = labelRowEl.createEl('select', { cls: 'bases-timeline-config-select' });
		labelSelect.createEl('option', { value: '', text: '— file name —' });
		allProps.forEach(prop => {
			const opt = labelSelect.createEl('option', { value: JSON.stringify(prop), text: this.getPropertyName(prop) });
			if (config.labelProp && JSON.stringify(config.labelProp) === JSON.stringify(prop)) opt.selected = true;
		});
		labelSelect.addEventListener('change', () => {
			const val = labelSelect.value;
			this.config.set('label', val ? JSON.parse(val) : null);
			this.render();
		});

		// Zoom slider
		const zoomRowEl = this.controlsEl.createDiv({ cls: 'bases-timeline-config-row' });
		zoomRowEl.createSpan({ cls: 'bases-timeline-config-label', text: 'Zoom:' });
		const zoomSlider = zoomRowEl.createEl('input', { type: 'range' });
		zoomSlider.min = '1'; zoomSlider.max = '5'; zoomSlider.step = '0.5';
		zoomSlider.value = String(config.zoom);
		const zoomValue = zoomRowEl.createSpan({ cls: 'bases-timeline-config-value', text: String(config.zoom) + '×' });
		zoomSlider.addEventListener('input', () => {
			const z = parseFloat(zoomSlider.value);
			zoomValue.textContent = z + '×';
			this.config.set('zoom', z);
			this.render();
		});

		// Color by property selector
		const propRowEl = this.controlsEl.createDiv({ cls: 'bases-timeline-config-row' });
		propRowEl.createSpan({ cls: 'bases-timeline-config-label', text: 'Color by:' });

		const propSelect = propRowEl.createEl('select', { cls: 'bases-timeline-config-select' });
		propSelect.createEl('option', { value: '', text: '— none —' });
		allProps.forEach(prop => {
			const name = this.getPropertyName(prop);
			const opt = propSelect.createEl('option', { value: JSON.stringify(prop), text: name });
			if (config.colorProp && JSON.stringify(config.colorProp) === JSON.stringify(prop)) {
				opt.selected = true;
			}
		});

		propSelect.addEventListener('change', () => {
			const val = propSelect.value;
			if (!val) {
				this.config.set('colorBy', null);
			} else {
				try {
					this.config.set('colorBy', JSON.parse(val));
				} catch { /* ignore */ }
			}
			this.render();
		});

		if (!config.colorProp) return;

		// Color pickers for each unique value
		const uniqueValues = this.getUniqueColorValues(config.colorProp);
		const { colorMap, changed } = this.ensureColorMap(config.colorMap, uniqueValues);
		if (changed) {
			this.config.set('colorMap', colorMap);
			config.colorMap = colorMap;
		}

		if (uniqueValues.length === 0) {
			this.controlsEl.createDiv({ cls: 'bases-timeline-controls-empty', text: 'No values found for the selected property.' });
			return;
		}

		let openPalette: HTMLElement | null = null;

		const listEl = this.controlsEl.createDiv({ cls: 'bases-timeline-color-list' });
		uniqueValues.forEach(value => {
			const itemEl = listEl.createDiv({ cls: 'bases-timeline-color-item' });
			itemEl.createDiv({ cls: 'bases-timeline-color-label', text: value });

			const currentColor = colorMap[value] || PALETTE[0];
			const dot = itemEl.createDiv({ cls: 'bases-timeline-swatch is-current' });
			dot.style.background = currentColor;
			dot.setAttribute('aria-label', 'Pick color');

			const paletteEl = itemEl.createDiv({ cls: 'bases-timeline-swatch-popup is-hidden' });
			PALETTE.forEach(color => {
				const swatch = paletteEl.createDiv({ cls: 'bases-timeline-swatch' });
				swatch.style.background = color;
				if (currentColor === color) swatch.addClass('is-selected');
				swatch.addEventListener('click', (e) => {
					e.stopPropagation();
					colorMap[value] = color;
					this.config.set('colorMap', colorMap);
					this.render();
				});
			});

			dot.addEventListener('click', (e) => {
				e.stopPropagation();
				if (openPalette && openPalette !== paletteEl) {
					openPalette.addClass('is-hidden');
					openPalette = null;
				}
				const isOpen = !paletteEl.hasClass('is-hidden');
				if (isOpen) {
					paletteEl.addClass('is-hidden');
					openPalette = null;
				} else {
					paletteEl.removeClass('is-hidden');
					openPalette = paletteEl;
				}
			});
		});
	}

	private getPropertyName(prop: BasesPropertyId): string {
		const str = String(prop);
		// BasesPropertyId format: "note.propname" | "file.something" | "formula.name"
		const dotIdx = str.indexOf('.');
		return dotIdx >= 0 ? str.slice(dotIdx + 1) : str;
	}

	private renderTimeline(config: TimelineConfig): void {
		const groups = this.data.groupedData || [];

		if (!config.startDateProp || !config.endDateProp) {
			this.bodyEl.createDiv({ cls: 'bases-timeline-empty', text: 'Select start and end date fields in view options.' });
			return;
		}

		// --- Step 1: Determine render window ---
		const rangeStartMs = this.config.get('rangeStartDate');
		const rangePresetDays = this.config.get('rangePresetDays');
		const hasFixedWindow = typeof rangeStartMs === 'number' && rangeStartMs > 0
			&& typeof rangePresetDays === 'number' && rangePresetDays > 0;

		this._lastConfig = config;

		if (hasFixedWindow) {
			// Fixed window: canvas can be set up immediately (min/max known from config).
			// All entry processing + row rendering is deferred async to keep the UI responsive.
			const min = new Date(rangeStartMs as number);
			min.setHours(0, 0, 0, 0);
			const max = new Date(min.getTime() + (rangePresetDays as number) * 24 * 60 * 60 * 1000);
			max.setHours(23, 59, 59, 999);
			this._rangeMin = min; this._rangeMax = max;

			// Render canvas structure synchronously — visible immediately
			const scrollerEl = this.bodyEl.createDiv({ cls: 'bases-timeline-scroller' });
			this._scrollerEl = scrollerEl;
			const canvasEl = scrollerEl.createDiv({ cls: 'bases-timeline-canvas' });
			const ticks = this.getTicksForScale(min, max, config.timeScale, config.weekStart);
			const zoom = Math.max(config.zoom, 1);
			if (config.timeScale === 'day') {
				canvasEl.style.width = `${config.frozenWidth + Math.max(900, ticks.length * 44 * zoom)}px`;
			} else if (config.timeScale === 'week') {
				canvasEl.style.width = `${config.frozenWidth + Math.max(900, ticks.length * 60 * zoom)}px`;
			} else if (config.timeScale === 'month') {
				canvasEl.style.width = `${config.frozenWidth + Math.max(900, ticks.length * 55 * zoom)}px`;
			} else {
				canvasEl.style.width = `calc(${config.frozenWidth}px + ${zoom * this.getScaleZoomFactor(config.timeScale) * 100}%)`;
			}
			this.renderTimeAxis(canvasEl, min, max, config, ticks);
			this.renderGridLines(canvasEl, ticks, min, max, config.timeScale, config.weekStart, config.frozenWidth);
			if (config.timeScale === 'day') {
				this.renderTodayMarker(canvasEl, min, max, true, config.frozenWidth);
			}
			this.attachRowClickHandler(canvasEl);

			// Defer all entry work async — yields to browser between chunks
			const seq = ++this._renderSeq;
			const startPropName = String(config.startDateProp).startsWith('note.')
				? this.getPropertyName(config.startDateProp!) : null;
			const endPropName = config.endDateProp && String(config.endDateProp).startsWith('note.')
				? this.getPropertyName(config.endDateProp) : null;
			const entryDatesCache = new Map<BasesEntry, { start: Date; end: Date; isPoint: boolean } | null>();
			const CHUNK = 50;

			(async () => {
				let rowIndex = 0;
				for (const group of groups) {
					if (this._renderSeq !== seq) return;

					const isGrouped = this.data.groupedData.length > 1 || group.hasKey();
					if (isGrouped) {
						const groupLabel = group.key && !Value.equals(group.key, NullValue.value)
							? group.key.toString() : 'Ungrouped';
						canvasEl.createDiv({ cls: 'bases-timeline-group', text: groupLabel });
					}

					const groupEntries = group.entries;
					for (let i = 0; i < groupEntries.length; i++) {
						// Yield to browser every CHUNK entries
						if (i > 0 && i % CHUNK === 0) {
							await new Promise<void>(r => setTimeout(r, 0));
							if (this._renderSeq !== seq) return;
						}

						const entry = groupEntries[i];

						// Resolve dates using metadata cache (fast), fall back to Bases API
						let dates = entryDatesCache.get(entry);
						if (dates === undefined) {
							dates = this.resolveEntryDatesFromCache(entry, startPropName, endPropName, min, max, config);
							entryDatesCache.set(entry, dates);
						}

						// Skip entries outside the render window
						if (dates && (dates.end < min || dates.start > max)) continue;

						this.renderRow(canvasEl, entry, config, min, max, rowIndex % 2 === 0, ticks, entryDatesCache);
						rowIndex++;
					}
				}
			})();

		} else {
			// Auto-fit: compute range from all entries synchronously (small dataset path)
			const entries = groups.flatMap(g => g.entries);
			const entryDatesCache = new Map<BasesEntry, { start: Date; end: Date; isPoint: boolean } | null>();
			let minDate: Date | null = null;
			let maxDate: Date | null = null;
			for (const entry of entries) {
				const dates = this.getEntryDates(entry, config.startDateProp!, config.endDateProp!);
				entryDatesCache.set(entry, dates);
				if (!dates) continue;
				if (!minDate || dates.start < minDate) minDate = dates.start;
				if (!maxDate || dates.end > maxDate) maxDate = dates.end;
			}
			if (!minDate || !maxDate) {
				this.bodyEl.createDiv({ cls: 'bases-timeline-empty', text: 'No tasks match the current filtered view.' });
				return;
			}
			let min = this.snapStartToScale(minDate, config.timeScale, config.weekStart);
			let max = this.snapEndToScale(maxDate, config.timeScale, config.weekStart);
			const weekMs = 7 * 24 * 60 * 60 * 1000;
			if (config.timeScale === 'week') {
				min = new Date(min.getTime() - weekMs);
				max = new Date(max.getTime() + 2 * weekMs); // 2 extra tail weeks
			} else if (config.timeScale !== 'day') {
				max = new Date(max.getTime() + weekMs);
			}

			this._rangeMin = min; this._rangeMax = max;
			const scrollerEl = this.bodyEl.createDiv({ cls: 'bases-timeline-scroller' });
			this._scrollerEl = scrollerEl;
			const canvasEl = scrollerEl.createDiv({ cls: 'bases-timeline-canvas' });
			const ticks = this.getTicksForScale(min, max, config.timeScale, config.weekStart);
			const zoom = Math.max(config.zoom, 1);
			const scaleZoom = this.getScaleZoomFactor(config.timeScale);
			if (config.timeScale === 'day') {
				canvasEl.style.width = `${config.frozenWidth + Math.max(900, ticks.length * 44 * zoom)}px`;
			} else if (config.timeScale === 'week') {
				canvasEl.style.width = `${config.frozenWidth + Math.max(900, ticks.length * 60 * zoom)}px`;
			} else if (config.timeScale === 'month') {
				canvasEl.style.width = `${config.frozenWidth + Math.max(900, ticks.length * 55 * zoom)}px`;
			} else {
				canvasEl.style.width = `calc(${config.frozenWidth}px + ${zoom * scaleZoom * 100}%)`;
			}
			this.renderTimeAxis(canvasEl, min, max, config, ticks);
			this.renderGridLines(canvasEl, ticks, min, max, config.timeScale, config.weekStart, config.frozenWidth);
			if (config.timeScale === 'day') {
				this.renderTodayMarker(canvasEl, min, max, true, config.frozenWidth);
			}
			this.attachRowClickHandler(canvasEl);

			for (const group of groups) {
				this.renderGroup(canvasEl, group, config, min, max, ticks, entryDatesCache);
			}
		}
	}

	/** Resolve entry dates using metadata cache (fast path). Falls back to Bases API if cache is incomplete. */
	private resolveEntryDatesFromCache(
		entry: BasesEntry,
		startPropName: string | null,
		endPropName: string | null,
		min: Date,
		max: Date,
		config: TimelineConfig
	): { start: Date; end: Date; isPoint: boolean } | null {
		if (startPropName) {
			const fmCache = this.app.metadataCache.getFileCache(entry.file)?.frontmatter;
			if (fmCache) {
				const startRaw = fmCache[startPropName];
				const start = this.parseRawFrontmatterDate(startRaw);

				// Clearly outside window — no need to check end
				if (start && start > max) return null;

				if (start) {
					const endRaw = endPropName ? fmCache[endPropName] : undefined;
					const hasEnd = endRaw != null && endRaw !== '' && endRaw !== false;
					const end = hasEnd ? this.parseRawFrontmatterDate(endRaw) : null;
					if (!hasEnd || end) {
						const effectiveEnd = end ?? new Date(start.getTime());
						if (start.getTime() <= effectiveEnd.getTime()) {
							return { start, end: effectiveEnd, isPoint: !hasEnd };
						}
					}
				}
			}
		}
		// Fall back to authoritative Bases API
		return this.getEntryDates(entry, config.startDateProp!, config.endDateProp!);
	}



	private centerOnDateHorizontal(scrollerEl: HTMLElement, canvasEl: HTMLElement, min: Date, max: Date, date: Date): void {
		const d = new Date(date);
		d.setHours(0, 0, 0, 0);
		if (d < min || d > max) return;

		const total = max.getTime() - min.getTime();
		if (total <= 0) return;
		const ratio = (d.getTime() - min.getTime()) / total;

		requestAnimationFrame(() => {
			const timelineWidth = canvasEl.scrollWidth;
			const x = ratio * timelineWidth;
			const target = x - scrollerEl.clientWidth * 0.5;
			const maxScroll = Math.max(0, scrollerEl.scrollWidth - scrollerEl.clientWidth);
			scrollerEl.scrollLeft = Math.max(0, Math.min(maxScroll, target));
		});
	}

	private renderTodayMarker(containerEl: HTMLElement, min: Date, max: Date, showLabel: boolean, labelColWidth = LABEL_COLUMN_WIDTH_PX): void {
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		if (today < min || today > max) return;

		const total = max.getTime() - min.getTime();
		const offset = today.getTime() - min.getTime();
		const left = total === 0 ? 0 : (offset / total) * 100;

		// Use actual label column width (not constant) to handle resized columns
		const markerTrackEl = containerEl.createDiv({ cls: 'bases-timeline-overlay-track' });
		markerTrackEl.style.left = `${labelColWidth}px`;
		markerTrackEl.style.width = `calc(100% - ${labelColWidth}px)`;

		if (showLabel) {
			const labelEl = markerTrackEl.createDiv({ cls: 'bases-timeline-today-label', text: 'Today' });
			labelEl.style.left = `${left}%`;
			labelEl.setAttribute('title', today.toLocaleDateString());
		}

		const markerEl = markerTrackEl.createDiv({ cls: 'bases-timeline-today-marker' });
		markerEl.style.left = `${left}%`;
		markerEl.setAttribute('title', `Today: ${today.toLocaleDateString()}`);
	}

	private renderTimeAxis(containerEl: HTMLElement, min: Date, max: Date, config: TimelineConfig, ticks?: Date[]): void {
		const axisEl = containerEl.createDiv({ cls: 'bases-timeline-axis' });
		axisEl.setAttribute('data-scale', config.timeScale);

		// Sticky frozen-left header: "Notes" label col + one header per prop col
		const spacerEl = axisEl.createDiv({ cls: 'bases-timeline-axis-spacer' });
		const notesHeaderEl = spacerEl.createDiv({ cls: 'bases-timeline-notes-header', text: 'Notes' });
		this.attachResizeHandle(notesHeaderEl, config);
		for (const prop of config.extraProps) {
			const key = JSON.stringify(prop);
			const w = config.propColWidths[key] ?? PROP_COLUMN_WIDTH_PX;
			const headerCell = spacerEl.createDiv({
				cls: 'bases-timeline-prop-col-header',
				text: this.config.getDisplayName(prop),
			});
			headerCell.style.width = `${w}px`;
			headerCell.style.minWidth = `${w}px`;
			this.attachPropColResizeHandle(headerCell, prop, config);
		}

		const timelineAxisEl = axisEl.createDiv({ cls: 'bases-timeline-axis-inner' });

		// All scales get a context header row — day uses 'week' context path (renders month spans)
		const contextScale = config.timeScale === 'day' ? 'week' : config.timeScale;
		this.renderContextHeader(timelineAxisEl, min, max, contextScale);

		const labelsEl = timelineAxisEl.createDiv({ cls: 'bases-timeline-axis-labels' });
		labelsEl.setAttribute('data-scale', config.timeScale);
		labelsEl.addClass('has-context');

		const resolvedTicks = ticks ?? this.getTicksForScale(min, max, config.timeScale, config.weekStart);
		const visibleTicks = this.reduceTicks(resolvedTicks, config.timeScale);
		const formatter = this.getAxisFormatter(min, max, config.timeScale);

		if (config.timeScale === 'day') {
			this.renderDayLabels(labelsEl, resolvedTicks, min, max, config.weekStart);
			return;
		}

		// Month, quarter, year scales: render span-style labels (each tick fills its slot width)
		if (config.timeScale === 'month' || config.timeScale === 'quarter' || config.timeScale === 'year') {
			this.renderSpanLabels(labelsEl, resolvedTicks, min, max, config.timeScale);
			return;
		}

		visibleTicks.forEach(date => {
			const total = max.getTime() - min.getTime();
			const offset = date.getTime() - min.getTime();
			const ratio = total === 0 ? 0 : offset / total;
			if (ratio >= -0.01 && ratio <= 1.01) {
				const label = this.formatTickLabel(date, config.timeScale, formatter);
				const tickEl = labelsEl.createDiv({ cls: 'bases-timeline-axis-label', text: label });
				tickEl.addClass(`is-${config.timeScale}-label`);
				tickEl.style.left = `${ratio * 100}%`;
				if (config.timeScale === 'week') {
					// Week labels are vertically centered; clamp horizontal for edge ticks
					if (ratio < 0.04) tickEl.style.transform = 'translate(0%, -50%)';
					else if (ratio > 0.96) tickEl.style.transform = 'translate(-100%, -50%)';
					else tickEl.style.transform = 'translate(-50%, -50%)';
				} else {
					// Clamp edge labels so they don't overflow axis bounds
					if (ratio < 0.04) tickEl.style.transform = 'translateX(0%)';
					else if (ratio > 0.96) tickEl.style.transform = 'translateX(-100%)';
					else tickEl.style.transform = 'translateX(-50%)';
				}
				if (config.timeScale === 'week') {
					const end = new Date(date);
					end.setDate(end.getDate() + 6);
					tickEl.setAttribute('title', `${date.toLocaleDateString()} – ${end.toLocaleDateString()}`);
				} else {
					tickEl.setAttribute('title', date.toLocaleDateString());
				}
			}
		});
	}

	/** Render tick labels as span boxes filling each slot (like day labels), for quarter and year scales. */
	private renderSpanLabels(labelsEl: HTMLElement, ticks: Date[], min: Date, max: Date, scale: string): void {
		labelsEl.addClass(`is-${scale}-scale`);
		const total = max.getTime() - min.getTime();

		const monthFmt = scale === 'month'
			? new Intl.DateTimeFormat(undefined, { month: 'short' })
			: null;

		for (let i = 0; i < ticks.length; i++) {
			const date = ticks[i];
			const startMs = Math.max(min.getTime(), date.getTime());
			const nextTick = ticks[i + 1];
			let slotEnd: number;
			if (scale === 'month') {
				const nextMonth = new Date(date);
				nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
				slotEnd = nextTick ? nextTick.getTime() : nextMonth.getTime();
			} else if (scale === 'quarter') {
				const nextQ = new Date(date);
				nextQ.setMonth(nextQ.getMonth() + 3, 1);
				slotEnd = nextTick ? nextTick.getTime() : nextQ.getTime();
			} else {
				// year
				const nextYear = new Date(date);
				nextYear.setFullYear(nextYear.getFullYear() + 1, 0, 1);
				slotEnd = nextTick ? nextTick.getTime() : nextYear.getTime();
			}
			const endMs = Math.min(max.getTime(), slotEnd);
			if (endMs <= startMs) continue;

			const leftRatio = total === 0 ? 0 : (startMs - min.getTime()) / total;
			const widthRatio = total === 0 ? 1 : (endMs - startMs) / total;
			if (leftRatio > 1.01) continue;

			let label: string;
			if (scale === 'month') {
				label = monthFmt!.format(date);
			} else if (scale === 'quarter') {
				const q = Math.floor(date.getMonth() / 3) + 1;
				label = `Q${q}`;
			} else {
				label = date.getFullYear().toString();
			}

			const el = labelsEl.createDiv({ cls: `bases-timeline-axis-label is-${scale}-label is-span-label`, text: label });
			el.style.left = `${leftRatio * 100}%`;
			el.style.width = `${Math.max(0, widthRatio * 100)}%`;
			el.setAttribute('title', date.toLocaleDateString());
		}
	}

	private renderContextHeader(containerEl: HTMLElement, min: Date, max: Date, scale: string): void {
		const headerEl = containerEl.createDiv({ cls: 'bases-timeline-context-header', attr: { 'data-scale': scale } });
		const total = max.getTime() - min.getTime();

		if (scale === 'week') {
			// Show month context
			const monthStart = new Date(min);
			monthStart.setDate(1);
			const monthEnd = new Date(monthStart);
			monthEnd.setMonth(monthEnd.getMonth() + 1, 0);

			let current = new Date(monthStart);
			while (current <= max) {
				const offset = Math.max(0, current.getTime() - min.getTime());
				const nextMonth = new Date(current);
				nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
				const endOffset = Math.min(total, nextMonth.getTime() - min.getTime());
				const width = total === 0 ? 0 : ((endOffset - offset) / total) * 100;
				const left = total === 0 ? 0 : (offset / total) * 100;

				if (width > 0 && left < 100) {
					const label = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(current);
					const monthEl = headerEl.createDiv({ cls: 'bases-timeline-context-segment', text: label });
					monthEl.style.left = `${left}%`;
					monthEl.style.width = `${width}%`;
				}

				current.setMonth(current.getMonth() + 1, 1);
			}
		} else if (scale === 'month') {
			// Month view context: show quarter spans (Q1/Q2/Q3/Q4 YYYY) for orientation
			let current = new Date(min);
			const qStartMonth = Math.floor(current.getMonth() / 3) * 3;
			current.setMonth(qStartMonth, 1);
			current.setHours(0, 0, 0, 0);

			while (current <= max) {
				const q = Math.floor(current.getMonth() / 3) + 1;
				const nextQ = new Date(current);
				nextQ.setMonth(nextQ.getMonth() + 3, 1);

				const offset = Math.max(0, current.getTime() - min.getTime());
				const endOffset = Math.min(total, nextQ.getTime() - min.getTime());
				const width = total === 0 ? 0 : ((endOffset - offset) / total) * 100;
				const left = total === 0 ? 0 : (offset / total) * 100;

				if (width > 0 && left < 100) {
					const label = `Q${q} ${current.getFullYear()}`;
					const qEl = headerEl.createDiv({ cls: 'bases-timeline-context-segment', text: label });
					qEl.style.left = `${left}%`;
					qEl.style.width = `${width}%`;
				}

				current.setMonth(current.getMonth() + 3, 1);
			}
		} else if (scale === 'quarter') {
			// Quarter view context: show year spans (provides the broader time context)
			let current = new Date(min);
			current.setMonth(0, 1);
			current.setHours(0, 0, 0, 0);

			while (current <= max) {
				const nextYear = new Date(current);
				nextYear.setFullYear(nextYear.getFullYear() + 1, 0, 1);

				const offset = Math.max(0, current.getTime() - min.getTime());
				const endOffset = Math.min(total, nextYear.getTime() - min.getTime());
				const width = total === 0 ? 0 : ((endOffset - offset) / total) * 100;
				const left = total === 0 ? 0 : (offset / total) * 100;

				if (width > 0 && left < 100) {
					const label = current.getFullYear().toString();
					const yearEl = headerEl.createDiv({ cls: 'bases-timeline-context-segment', text: label });
					yearEl.style.left = `${left}%`;
					yearEl.style.width = `${width}%`;
				}

				current.setFullYear(current.getFullYear() + 1);
			}
		} else if (scale === 'year') {
			// Show each individual year as a labeled span
			let current = new Date(min);
			current.setMonth(0, 1);
			current.setHours(0, 0, 0, 0);

			while (current <= max) {
				const nextYear = new Date(current);
				nextYear.setFullYear(nextYear.getFullYear() + 1, 0, 1);

				const offset = Math.max(0, current.getTime() - min.getTime());
				const endOffset = Math.min(total, nextYear.getTime() - min.getTime());
				const width = total === 0 ? 0 : ((endOffset - offset) / total) * 100;
				const left = total === 0 ? 0 : (offset / total) * 100;

				if (width > 0 && left < 100) {
					const label = current.getFullYear().toString();
					const yearEl = headerEl.createDiv({ cls: 'bases-timeline-context-segment', text: label });
					yearEl.style.left = `${left}%`;
					yearEl.style.width = `${width}%`;
				}

				current.setFullYear(current.getFullYear() + 1);
			}
		}
	}

	private getTicksForScale(min: Date, max: Date, scale: string, weekStart: 'monday' | 'sunday' = 'monday'): Date[] {
		const ticks: Date[] = [];
		const current = new Date(min);

		if (scale === 'day') {
			current.setHours(0, 0, 0, 0);
			while (current <= max) {
				ticks.push(new Date(current));
				current.setDate(current.getDate() + 1);
			}
		} else if (scale === 'week') {
			const first = new Date(current);
			const day = current.getDay();
			const shift = weekStart === 'sunday' ? day : (day === 0 ? 6 : day - 1);
			first.setDate(current.getDate() - shift);
			first.setHours(0, 0, 0, 0);
			while (first <= max) {
				ticks.push(new Date(first));
				first.setDate(first.getDate() + 7);
			}
		} else if (scale === 'month') {
			current.setDate(1);
			current.setHours(0, 0, 0, 0);
			while (current <= max) {
				ticks.push(new Date(current));
				current.setMonth(current.getMonth() + 1);
			}
		} else if (scale === 'quarter') {
			const q = Math.floor(current.getMonth() / 3);
			current.setMonth(q * 3);
			current.setDate(1);
			current.setHours(0, 0, 0, 0);
			while (current <= max) {
				ticks.push(new Date(current));
				current.setMonth(current.getMonth() + 3);
			}
		} else if (scale === 'year') {
			current.setMonth(0, 1);
			current.setHours(0, 0, 0, 0);
			while (current <= max) {
				ticks.push(new Date(current));
				current.setFullYear(current.getFullYear() + 1);
			}
		}

		return ticks.length > 0 ? ticks : [new Date(min)];
	}

	private renderDayLabels(labelsEl: HTMLElement, dayTicks: Date[], min: Date, max: Date, weekStart: 'monday' | 'sunday'): void {
		labelsEl.addClass('is-day-scale');
		const total = max.getTime() - min.getTime();
		const oneDayMs = 1000 * 60 * 60 * 24;

		for (let i = 0; i < dayTicks.length; i++) {
			const date = dayTicks[i];
			const startMs = Math.max(min.getTime(), date.getTime());
			const nextTick = dayTicks[i + 1];
			const endMs = Math.min(max.getTime(), nextTick ? nextTick.getTime() : date.getTime() + oneDayMs);
			if (endMs <= startMs) continue;

			const leftRatio = total === 0 ? 0 : (startMs - min.getTime()) / total;
			const widthRatio = total === 0 ? 1 : (endMs - startMs) / total;
			if (leftRatio < -0.01 || leftRatio > 1.01) continue;

			const weekday = this.getCompactWeekdayLabel(date, weekStart);
			const dayEl = labelsEl.createDiv({ cls: 'bases-timeline-axis-label is-day-label', text: `${weekday} ${date.getDate()}` });
			dayEl.style.left = `${leftRatio * 100}%`;
			dayEl.style.width = `${Math.max(0, widthRatio * 100)}%`;
		}
	}

	private getCompactWeekdayLabel(date: Date, _weekStart: 'monday' | 'sunday'): string {
		// getDay(): 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
		const labels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
		return labels[date.getDay()] ?? new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date).slice(0, 2);
	}

	private attachResizeHandle(labelEl: HTMLElement, config: TimelineConfig): void {
		const handle = labelEl.createDiv({ cls: 'bases-timeline-resize-handle' });
		let startX = 0;
		let startWidth = 0;

		const onMouseMove = (e: MouseEvent) => {
			const delta = e.clientX - startX;
			const newWidth = Math.max(LABEL_COLUMN_MIN_PX, Math.min(LABEL_COLUMN_MAX_PX, startWidth + delta));
			this.containerEl.style.setProperty('--timeline-label-col-width', `${newWidth}px`);
		};

		const onMouseUp = (e: MouseEvent) => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			document.body.removeClass('bases-timeline-resizing');
			const delta = e.clientX - startX;
			const newWidth = Math.max(LABEL_COLUMN_MIN_PX, Math.min(LABEL_COLUMN_MAX_PX, startWidth + delta));
			this.config.set('labelColWidth', newWidth);
		};

		handle.addEventListener('mousedown', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			startX = e.clientX;
			startWidth = parseInt(
				this.containerEl.style.getPropertyValue('--timeline-label-col-width') || String(config.labelColWidth),
				10
			);
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
			document.body.addClass('bases-timeline-resizing');
		});
	}

	private attachPropColResizeHandle(headerCell: HTMLElement, prop: BasesPropertyId, config: TimelineConfig): void {
		const handle = headerCell.createDiv({ cls: 'bases-timeline-resize-handle' });
		const key = JSON.stringify(prop);
		const PROP_MIN = 60;
		const PROP_MAX = 400;
		let startX = 0;
		let startWidth = 0;

		const onMouseMove = (e: MouseEvent) => {
			const delta = e.clientX - startX;
			const newWidth = Math.max(PROP_MIN, Math.min(PROP_MAX, startWidth + delta));
			// Update all cells for this prop column via CSS custom property on containerEl
			this.containerEl.style.setProperty(`--tl-prop-col-width-${key.replace(/[^a-z0-9]/gi, '_')}`, `${newWidth}px`);
			// Also directly update header cell for live resize feel
			headerCell.style.width = `${newWidth}px`;
			headerCell.style.minWidth = `${newWidth}px`;
			// Update all row cells for this prop
			this.containerEl.querySelectorAll<HTMLElement>(`.bases-timeline-prop-cell[data-prop-key="${CSS.escape(key)}"]`).forEach(cell => {
				cell.style.width = `${newWidth}px`;
				cell.style.minWidth = `${newWidth}px`;
			});
			// Recompute frozenWidth on container
			this._updateFrozenWidth(config, key, newWidth);
		};

		const onMouseUp = (e: MouseEvent) => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			document.body.removeClass('bases-timeline-resizing');
			const delta = e.clientX - startX;
			const newWidth = Math.max(PROP_MIN, Math.min(PROP_MAX, startWidth + delta));
			// Persist: read current saved widths, update this key, save back
			const saved = (this.config.get('propColWidths') ?? {}) as Record<string, number>;
			saved[key] = newWidth;
			this.config.set('propColWidths', saved);
		};

		handle.addEventListener('mousedown', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			startX = e.clientX;
			startWidth = parseInt(headerCell.style.width || String(config.propColWidths[key] ?? PROP_COLUMN_WIDTH_PX), 10);
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
			document.body.addClass('bases-timeline-resizing');
		});
	}

	private _updateFrozenWidth(config: TimelineConfig, changedKey: string, changedWidth: number): void {
		// Recompute frozenWidth from current header cells
		let frozen = config.labelColWidth;
		for (const prop of config.extraProps) {
			const k = JSON.stringify(prop);
			frozen += (k === changedKey ? changedWidth : (config.propColWidths[k] ?? PROP_COLUMN_WIDTH_PX));
		}
		this.containerEl.style.setProperty('--timeline-frozen-width', `${frozen}px`);
		// Update left offsets on all prop cells
		let left = config.labelColWidth;
		for (const prop of config.extraProps) {
			const k = JSON.stringify(prop);
			const w = k === changedKey ? changedWidth : (config.propColWidths[k] ?? PROP_COLUMN_WIDTH_PX);
			this.containerEl.querySelectorAll<HTMLElement>(`.bases-timeline-prop-cell[data-prop-key="${CSS.escape(k)}"]`).forEach(cell => {
				cell.style.left = `${left}px`;
			});
			left += w;
		}
	}

	private attachRowClickHandler(canvasEl: HTMLElement): void {
		let lastBarClickTime = 0;
		let lastBarClickPath = '';
		canvasEl.addEventListener('click', (evt: MouseEvent) => {
			// Ignore clicks that follow a drag operation
			if (this._dragState) return;

			const target = evt.target as HTMLElement;
			const rowEl = target.closest('[data-entry-path]') as HTMLElement | null;
			if (!rowEl) return;
			const path = rowEl.getAttribute('data-entry-path');
			if (!path) return;

			// Single click on label → open note
			const isLabel = target.closest('.bases-timeline-label');
			if (isLabel) {
				evt.preventDefault();
				void this.app.workspace.openLinkText(path, '', evt.ctrlKey || evt.metaKey);
				return;
			}

			// Double‑click on bar → open note
			const isBar = target.closest('.bases-timeline-bar') && !target.closest('.bases-timeline-bar-handle');
			if (isBar) {
				const now = Date.now();
				const isDouble = (now - lastBarClickTime < 300) && (path === lastBarClickPath);
				if (isDouble) {
					evt.preventDefault();
					void this.app.workspace.openLinkText(path, '', evt.ctrlKey || evt.metaKey);
				}
				lastBarClickTime = now;
				lastBarClickPath = path;
				return;
			}
		});
	}

	private renderTrackGridLines(trackEl: HTMLElement, ticks: Date[], min: Date, max: Date, scale: string, weekStart: 'monday' | 'sunday'): void {
		const total = max.getTime() - min.getTime();
		if (total === 0) return;

		// Weekend backgrounds (day scale)
		if (scale === 'day') {
			const current = new Date(min);
			current.setHours(0, 0, 0, 0);
			const oneDay = 1000 * 60 * 60 * 24;
			while (current <= max) {
				const dayOfWeek = current.getDay();
				if (dayOfWeek === 0 || dayOfWeek === 6) {
					const start = Math.max(min.getTime(), current.getTime());
					const end = Math.min(max.getTime(), current.getTime() + oneDay);
					if (end > start) {
						const left = ((start - min.getTime()) / total) * 100;
						const width = ((end - start) / total) * 100;
						const bg = trackEl.createDiv({ cls: 'bases-timeline-weekend-bg' });
						bg.style.left = `${left}%`;
						bg.style.width = `${width}%`;
					}
				}
				current.setDate(current.getDate() + 1);
			}
		}

		// Grid lines
		const weekBoundaryRatios: number[] = [];
		const visibleTicks = scale === 'week' ? ticks : this.reduceTicks(ticks, scale);
		visibleTicks.forEach(tick => {
			const offset = tick.getTime() - min.getTime();
			const left = (offset / total) * 100;
			if (left < 0 || left > 100) return;

			if (scale === 'week') return; // week uses overlay

			const isYearBoundary = tick.getMonth() === 0 && tick.getDate() === 1;
			const lineEl = trackEl.createDiv({ cls: 'bases-timeline-grid-line' });
			lineEl.style.left = `${left}%`;
			if (scale === 'day') {
				lineEl.addClass('is-minor');
				const isWeekStart = weekStart === 'sunday' ? tick.getDay() === 0 : tick.getDay() === 1;
				if (isWeekStart) weekBoundaryRatios.push(left / 100);
			} else if (isYearBoundary) {
				lineEl.addClass('is-year-boundary');
			} else {
				lineEl.addClass('is-major');
			}
		});

		// Week boundary bold lines (day scale)
		for (const ratio of weekBoundaryRatios) {
			const line = trackEl.createDiv({ cls: 'bases-timeline-grid-line is-week-boundary' });
			line.style.left = `${ratio * 100}%`;
		}

		// Week grid lines (week scale) — also mark year boundaries
		if (scale === 'week') {
			for (const tick of ticks) {
				const ratio = (tick.getTime() - min.getTime()) / total;
				if (ratio < 0 || ratio > 1) continue;
				const isYearBoundary = tick.getMonth() === 0 && tick.getDate() === 1;
				const line = trackEl.createDiv({ cls: 'bases-timeline-grid-line' });
				line.style.left = `${ratio * 100}%`;
				line.addClass(isYearBoundary ? 'is-year-boundary' : 'is-major');
			}
		}
	}

	private renderGridLines(containerEl: HTMLElement, ticks: Date[], min: Date, max: Date, scale: string, weekStart: 'monday' | 'sunday', labelColWidth: number): void {
		const gridEl = containerEl.createDiv({ cls: 'bases-timeline-grid' });
		// Offset grid past the sticky label column
		gridEl.style.left = `${labelColWidth}px`;
		gridEl.style.width = `calc(100% - ${labelColWidth}px)`;
		const total = max.getTime() - min.getTime();
		const weekBoundaryRatios: number[] = [];

		// For day scale, render weekend background areas
		if (scale === 'day' && total > 0) {
			const current = new Date(min);
			current.setHours(0, 0, 0, 0);
			const oneDay = 1000 * 60 * 60 * 24;
			while (current <= max) {
				const dayOfWeek = current.getDay();
				if (dayOfWeek === 0 || dayOfWeek === 6) {
					const start = Math.max(min.getTime(), current.getTime());
					const end = Math.min(max.getTime(), current.getTime() + oneDay);
					if (end > start) {
						const left = ((start - min.getTime()) / total) * 100;
						const width = ((end - start) / total) * 100;
						const weekendBg = gridEl.createDiv({ cls: 'bases-timeline-weekend-bg' });
						weekendBg.style.left = `${left}%`;
						weekendBg.style.width = `${width}%`;
					}
				}
				current.setDate(current.getDate() + 1);
			}
		}

		// For non-day, non-week scales: render minor grid lines
		if (scale !== 'day' && scale !== 'week') {
			const minorTicks = this.getMinorGridTicks(min, max, scale, weekStart);
			minorTicks.forEach(tick => {
				const offset = tick.getTime() - min.getTime();
				const left = total === 0 ? 0 : (offset / total) * 100;
				const lineEl = gridEl.createDiv({ cls: 'bases-timeline-grid-line is-minor' });
				lineEl.style.left = `${left}%`;
			});
		}

		ticks.forEach(tick => {
			const offset = tick.getTime() - min.getTime();
			const left = total === 0 ? 0 : (offset / total) * 100;

			if (scale === 'week') {
				return;
			}

			const lineEl = gridEl.createDiv({ cls: 'bases-timeline-grid-line' });
			lineEl.style.left = `${left}%`;

			if (scale === 'day') {
				lineEl.addClass('is-minor');
				const isWeekStart = weekStart === 'sunday' ? tick.getDay() === 0 : tick.getDay() === 1;
				if (isWeekStart) {
					weekBoundaryRatios.push(left / 100);
				}
			} else {
				lineEl.addClass('is-major');
			}

			// Additional major boundaries (year boundaries for non-year scales)
			if (scale !== 'year') {
				const nextYear = new Date(tick);
				nextYear.setFullYear(nextYear.getFullYear() + 1);
				nextYear.setMonth(0, 1);
				if (tick.getMonth() === 0 && tick.getDate() === 1 && nextYear <= max) {
					lineEl.addClass('is-year-boundary');
				}
			}
		});

		if (scale === 'day' && weekBoundaryRatios.length > 0) {
			const overlayEl = containerEl.createDiv({ cls: 'bases-timeline-week-boundary-overlay' });
			overlayEl.style.left = `${labelColWidth}px`;
			overlayEl.style.width = `calc(100% - ${labelColWidth}px)`;
			const unique = Array.from(new Set(weekBoundaryRatios.map(r => Number(r.toFixed(6)))));
			for (const ratio of unique) {
				if (ratio < 0 || ratio > 1) continue;
				const weekLine = overlayEl.createDiv({ cls: 'bases-timeline-week-boundary-line' });
				weekLine.style.left = `${ratio * 100}%`;
			}
		}

		if (scale === 'week') {
			const overlayEl = containerEl.createDiv({ cls: 'bases-timeline-week-grid-overlay' });
			overlayEl.style.left = `var(--timeline-frozen-width, ${labelColWidth}px)`;
			overlayEl.style.width = `calc(100% - var(--timeline-frozen-width, ${labelColWidth}px))`;
			for (const tick of ticks) {
				const ratio = total === 0 ? 0 : (tick.getTime() - min.getTime()) / total;
				if (ratio < 0 || ratio > 1) continue;
				const line = overlayEl.createDiv({ cls: 'bases-timeline-week-grid-line' });
				line.style.left = `${ratio * 100}%`;
			}
		}
	}

	private getMinorGridTicks(min: Date, max: Date, scale: string, weekStart: 'monday' | 'sunday'): Date[] {
		const ticks: Date[] = [];
		const current = new Date(min);

		if (scale === 'week') {
			// Minor ticks: daily
			current.setHours(0, 0, 0, 0);
			while (current <= max) {
				ticks.push(new Date(current));
				current.setDate(current.getDate() + 1);
			}
		} else if (scale === 'month') {
			// Minor ticks: weekly
			const first = new Date(current);
			const day = current.getDay();
			const shift = weekStart === 'sunday' ? day : (day === 0 ? 6 : day - 1);
			first.setDate(current.getDate() - shift);
			first.setHours(0, 0, 0, 0);
			while (first <= max) {
				ticks.push(new Date(first));
				first.setDate(first.getDate() + 7);
			}
		} else if (scale === 'quarter') {
			// Minor ticks: monthly
			current.setDate(1);
			current.setHours(0, 0, 0, 0);
			while (current <= max) {
				ticks.push(new Date(current));
				current.setMonth(current.getMonth() + 1);
			}
		} else if (scale === 'year') {
			// Minor ticks: monthly
			current.setDate(1);
			current.setHours(0, 0, 0, 0);
			while (current <= max) {
				ticks.push(new Date(current));
				current.setMonth(current.getMonth() + 1);
			}
		}

		return ticks;
	}

	private reduceTicks(ticks: Date[], scale: string): Date[] {
		// day, week, month, year: never reduce — always show every tick
		if (scale === 'day' || scale === 'week' || scale === 'month' || scale === 'year') return ticks;
		const maxVisible = 16;
		if (ticks.length <= maxVisible) return ticks;
		const step = Math.ceil(ticks.length / maxVisible);
		return ticks.filter((_, i) => i % step === 0 || i === ticks.length - 1);
	}

	private renderGroup(containerEl: HTMLElement, group: BasesEntryGroup, config: TimelineConfig, min: Date, max: Date, ticks: Date[], entryDatesCache: Map<BasesEntry, { start: Date; end: Date; isPoint: boolean } | null>): void {
		const isGrouped = this.data.groupedData.length > 1 || group.hasKey();
		const groupLabel = (group.key && !Value.equals(group.key, NullValue.value))
			? group.key.toString()
			: 'Ungrouped';

		if (isGrouped) {
			const groupHeaderEl = containerEl.createDiv({ cls: 'bases-timeline-group', text: groupLabel });

			// Make the group header a drop target
			groupHeaderEl.addEventListener('dragover', (e) => {
				e.preventDefault();
				groupHeaderEl.addClass('is-drag-over');
			});
			groupHeaderEl.addEventListener('dragleave', () => {
				groupHeaderEl.removeClass('is-drag-over');
			});
			groupHeaderEl.addEventListener('drop', (e) => {
				e.preventDefault();
				groupHeaderEl.removeClass('is-drag-over');
				const raw = e.dataTransfer?.getData('text/plain');
				if (!raw) return;
				try {
					const { path, fromGroup } = JSON.parse(raw) as { path: string; fromGroup: string };
					void this._dropToGroup(path, fromGroup, groupLabel, config.groupByProp);
				} catch { /* ignore malformed drag data */ }
			});
		}

		let rowIndex = 0;
		group.entries.forEach((entry) => {
			const dates = entryDatesCache.get(entry) ?? null;
			if (dates && (dates.end < min || dates.start > max)) return;
			this.renderRow(containerEl, entry, config, min, max, rowIndex % 2 === 0, ticks, entryDatesCache, isGrouped ? groupLabel : null);
			rowIndex++;
		});
	}

	private renderRow(containerEl: HTMLElement, entry: BasesEntry, config: TimelineConfig, min: Date, max: Date, isEven: boolean = false, ticks: Date[], entryDatesCache: Map<BasesEntry, { start: Date; end: Date; isPoint: boolean } | null>, currentGroupLabel: string | null = null): void {
		const rowEl = containerEl.createDiv({ cls: 'bases-timeline-row' });
		if (isEven) rowEl.addClass('is-even');
		rowEl.setAttribute('data-entry-path', entry.file.path);

		// Drag handle — only shown when grouping is active
		if (currentGroupLabel !== null) {
			const handle = rowEl.createDiv({ cls: 'bases-timeline-drag-handle', attr: { draggable: 'true', title: 'Drag to move to another group' } });
			setIcon(handle, 'grip-vertical');
			handle.addEventListener('dragstart', (e) => {
				const payload = JSON.stringify({ path: entry.file.path, fromGroup: currentGroupLabel });
				e.dataTransfer?.setData('text/plain', payload);
				e.dataTransfer!.effectAllowed = 'move';
				rowEl.addClass('is-dragging');
			});
			handle.addEventListener('dragend', () => {
				rowEl.removeClass('is-dragging');
			});

			// Make the row itself a drop target (any row in another group works)
			rowEl.addEventListener('dragover', (e) => {
				const raw = e.dataTransfer?.types.includes('text/plain');
				if (!raw) return;
				e.preventDefault();
				rowEl.addClass('is-drop-target');
			});
			rowEl.addEventListener('dragleave', () => rowEl.removeClass('is-drop-target'));
			rowEl.addEventListener('drop', (e) => {
				e.preventDefault();
				rowEl.removeClass('is-drop-target');
				const data = e.dataTransfer?.getData('text/plain');
				if (!data) return;
				try {
					const { path, fromGroup } = JSON.parse(data) as { path: string; fromGroup: string };
					if (path === entry.file.path) return; // dropped onto itself
					void this._dropToGroup(path, fromGroup, currentGroupLabel!, config.groupByProp);
				} catch { /* ignore */ }
			});
		}

		const label = this.getEntryLabel(entry, config.labelProp);
		const labelEl = rowEl.createDiv({ cls: 'bases-timeline-label' });
		const labelInnerEl = labelEl.createDiv({ cls: 'bases-timeline-label-inner' });
		const labelSpan = labelInnerEl.createEl('span', { text: label });
		labelEl.addEventListener('mouseover', (e: MouseEvent) => {
			this.app.workspace.trigger('hover-link', {
				event: e, source: 'timeline-for-bases',
				hoverParent: labelEl, targetEl: labelEl,
				linktext: entry.file.path,
			});
		});

		// Extra property columns — one sticky cell per prop, rendered after label cell
		let propLeft = config.labelColWidth;
		for (const prop of config.extraProps) {
			const key = JSON.stringify(prop);
			const w = config.propColWidths[key] ?? PROP_COLUMN_WIDTH_PX;
			const val = entry.getValue(prop);
			const text = (val && val.isTruthy()) ? val.toString() : '';
			const propCell = rowEl.createDiv({ cls: 'bases-timeline-prop-cell' });
			propCell.setAttribute('data-prop-key', key);
			propCell.style.left = `${propLeft}px`;
			propCell.style.width = `${w}px`;
			propCell.style.minWidth = `${w}px`;
			propLeft += w;

			const isWritableProp = String(prop).startsWith('note.');
			const propKey = String(prop).replace(/^note\./, '');

			if (isWritableProp) {
				const propType = this._getPropType(propKey);
				const valueSpan = propCell.createEl('span', { text, cls: 'bases-timeline-prop-cell-value' });

				if (propType === 'checkbox') {
					// Checkbox: toggle on pencil click, no input
					const isChecked = text === 'true';
					if (isChecked) valueSpan.addClass('is-checked');
					const editBtn = propCell.createEl('button', { cls: 'bases-timeline-prop-edit-btn' });
					setIcon(editBtn, isChecked ? 'check-square' : 'square');
					editBtn.setAttribute('aria-label', 'Toggle');
					editBtn.addEventListener('click', async (e: MouseEvent) => {
						e.stopPropagation(); e.preventDefault();
						const newVal = !isChecked;
						const file = this.app.vault.getFileByPath(entry.file.path);
						if (file) {
							await this.app.fileManager.processFrontMatter(file, fm => { fm[propKey] = newVal; });
						}
					});
				} else if (propType === 'date' || propType === 'datetime') {
					// Date/datetime: pencil opens a floating date picker
					const editBtn = propCell.createEl('button', { cls: 'bases-timeline-prop-edit-btn' });
					setIcon(editBtn, 'pencil');
					editBtn.setAttribute('aria-label', 'Edit date');
					editBtn.addEventListener('click', (e: MouseEvent) => {
						e.stopPropagation(); e.preventDefault();
						this._showPropDatePicker(propCell, entry.file.path, propKey, propType, text, (newVal) => {
							valueSpan.textContent = newVal;
						});
					});
				} else {
					// Text / number / multitext / tags / anything else: inline input
					const editBtn = propCell.createEl('button', { cls: 'bases-timeline-prop-edit-btn' });
					setIcon(editBtn, 'pencil');
					editBtn.setAttribute('aria-label', 'Edit');

					editBtn.addEventListener('click', (e: MouseEvent) => {
						e.stopPropagation(); e.preventDefault();
						editBtn.hide();
						const input = document.createElement('input');
						input.type = propType === 'number' ? 'number' : 'text';
						input.value = valueSpan.textContent || '';
						input.className = 'bases-timeline-prop-cell-input';
						valueSpan.replaceWith(input);
						input.focus(); input.select();
						input.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
						input.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation());

						// Suggestions dropdown for text fields
						let dropdown: HTMLElement | null = null;
						const removeDropdown = () => { dropdown?.remove(); dropdown = null; };

						if (propType !== 'number') {
							const allValues = this.getVaultValuesForProp(propKey);

							const showDropdown = (filter: string, showAll = false) => {
								removeDropdown();
								const lower = filter.toLowerCase();
								const matches = allValues.filter(v =>
									showAll
										? true
										: v.toLowerCase().includes(lower)
								);
								if (matches.length === 0) return;

								dropdown = document.body.createDiv({ cls: 'bases-timeline-prop-suggestions' });
								const rect = input.getBoundingClientRect();
								dropdown.style.top = `${rect.bottom + 2}px`;
								dropdown.style.left = `${rect.left}px`;
								dropdown.style.minWidth = `${Math.max(rect.width, 120)}px`;

								matches.slice(0, 12).forEach(v => {
									const item = dropdown!.createDiv({ cls: 'bases-timeline-prop-suggestion-item', text: v });
									if (v === filter) item.addClass('is-selected');
									item.addEventListener('mousedown', (me: MouseEvent) => {
										me.preventDefault();
										input.value = v;
										removeDropdown();
										input.blur();
									});
								});
							};

								input.addEventListener('input', () => showDropdown(input.value));
							input.addEventListener('click', (ce: MouseEvent) => { ce.stopPropagation(); showDropdown(input.value, true); });
							// Show immediately after DOM insertion
							setTimeout(() => showDropdown(input.value, true), 0);
						}

						const save = async () => {
							removeDropdown();
							const newVal = input.value.trim();
							input.replaceWith(valueSpan);
							editBtn.show();
							if (newVal !== text) {
								valueSpan.textContent = newVal;
								const file = this.app.vault.getFileByPath(entry.file.path);
								if (file) {
									await this.app.fileManager.processFrontMatter(file, fm => {
										if (newVal === '') {
											delete fm[propKey];
										} else if (propType === 'number') {
											fm[propKey] = parseFloat(newVal);
										} else {
											fm[propKey] = newVal;
										}
									});
								}
							}
						};
						input.addEventListener('blur', save);
						input.addEventListener('keydown', (ke: KeyboardEvent) => {
							if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
							if (ke.key === 'Escape') { removeDropdown(); input.value = text; input.blur(); }
							if (ke.key === 'ArrowDown' && dropdown) {
								ke.preventDefault();
								(dropdown.firstElementChild as HTMLElement)?.focus();
							}
						});
					});
				}
			} else {
				// Read-only cell
				propCell.createEl('span', { text, cls: 'bases-timeline-prop-cell-value is-readonly' });
			}
		}



		// Inline edit: pencil icon appears on hover → click to edit
		const labelPropKey = config.labelProp ? String(config.labelProp).replace(/^note\./, '') : null;
		if (labelPropKey) {
			const editBtn = labelEl.createEl('button', { cls: 'bases-timeline-label-edit-btn' });
			setIcon(editBtn, 'pencil');
			editBtn.setAttribute('aria-label', 'Edit name');

			editBtn.addEventListener('click', (e: MouseEvent) => {
				e.stopPropagation(); e.preventDefault();
				editBtn.hide();
				const input = document.createElement('input');
				input.type = 'text';
				input.value = labelSpan.textContent || '';
				input.className = 'bases-timeline-label-input';
				labelSpan.replaceWith(input);
				input.focus(); input.select();
				input.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
				input.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation());

				const save = async () => {
					const newVal = input.value.trim();
					input.replaceWith(labelSpan);
					editBtn.show();
					if (newVal && newVal !== label) {
						labelSpan.textContent = newVal;
						const file = this.app.vault.getFileByPath(entry.file.path);
						if (file) {
							await this.app.fileManager.processFrontMatter(file, fm => { fm[labelPropKey] = newVal; });
						}
					}
				};
				input.addEventListener('blur', save);
				input.addEventListener('keydown', (ke: KeyboardEvent) => {
					if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
					if (ke.key === 'Escape') { input.value = label; input.blur(); }
				});
			});
		}

		const trackEl = rowEl.createDiv({ cls: 'bases-timeline-track' });

		const dates = entryDatesCache.get(entry) ?? null;
		if (!dates) {
			rowEl.addClass('is-missing');
			labelEl.addClass('is-missing');
			// Allow click-drag on the track to draw a new bar and set dates (only for writable props)
			if (config.startDateProp && config.endDateProp && config.startWritable && config.endWritable) {
				const startKey = String(config.startDateProp).replace(/^note\./, '');
				const endKey   = String(config.endDateProp).replace(/^note\./, '');
				trackEl.addClass('is-draw-zone');
				trackEl.setAttribute('title', 'Click and drag to set dates');
				trackEl.addEventListener('mousedown', (e: MouseEvent) => {
					if (e.button !== 0 || !this._rangeMin || !this._rangeMax) return;
					e.preventDefault();
					e.stopPropagation();
					const rect     = trackEl.getBoundingClientRect();
					const totalMs  = this._rangeMax.getTime() - this._rangeMin.getTime();
					const pct      = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
					const anchorDate = this._localMidnight(new Date(this._rangeMin.getTime() + pct * totalMs));
					const ghostEl  = trackEl.createDiv({ cls: 'bases-timeline-draw-ghost' });
					ghostEl.style.left  = `${pct * 100}%`;
					ghostEl.style.width = '0%';
					this._draw = { entryPath: entry.file.path, startKey, endKey, anchorDate, rangeMin: this._rangeMin!, totalMs, trackEl, ghostEl };
				});
			}
			return;
		}

		const total = max.getTime() - min.getTime();

		// Compute bar geometry using tick positions directly.
		// This avoids UTC-vs-local drift: ticks are local-midnight dates (setHours(0,0,0,0)),
		// while Date.parse("YYYY-MM-DD") gives UTC midnight. Using ticks as anchors ensures
		// the bar left/right edges align exactly with the column boundaries drawn by renderDayLabels.
		const toLocalMidnight = (d: Date): number => {
			const r = new Date(d); r.setHours(0, 0, 0, 0); return r.getTime();
		};
		const startMs = toLocalMidnight(dates.start);
		// End is exclusive: the bar fills up to (but not including) the day AFTER end.
		const localEnd = new Date(dates.end);
		localEnd.setHours(0, 0, 0, 0);
		localEnd.setDate(localEnd.getDate() + 1);  // calendar day after end (DST-safe)
		const endMs = localEnd.getTime();

		const startOffset = startMs - min.getTime();
		// For point entries (no end date), use 1 day duration so the bar fills the day column
		const oneDayMs = 24 * 60 * 60 * 1000;
		const effectiveDuration = dates.isPoint ? oneDayMs : Math.max(oneDayMs, endMs - startMs);

		const left = total === 0 ? 0 : (startOffset / total) * 100;
		const width = total === 0 ? 100 : (effectiveDuration / total) * 100;

		const barEl = trackEl.createDiv({ cls: 'bases-timeline-bar' });
		if (width < 0.8) {
			barEl.addClass('is-compressed');
		}
		barEl.style.left = `${left}%`;
		barEl.style.width = `${width}%`;

		const color = this.getEntryColor(entry, config.colorProp, config.colorMap);
		if (color) {
			barEl.style.backgroundColor = color;
		}

		barEl.setAttribute('title', `${label} (${dates.start.toLocaleDateString()} → ${dates.end.toLocaleDateString()})`);
		barEl.addEventListener('mouseover', (e: MouseEvent) => {
			// Don't trigger during drag
			if (this._dragState) return;
			this.app.workspace.trigger('hover-link', {
				event: e, source: 'timeline-for-bases',
				hoverParent: barEl, targetEl: barEl,
				linktext: entry.file.path,
			});
		});

		// Drag & resize — only when we know which frontmatter keys to write
		const startPropKey = config.startDateProp ? String(config.startDateProp).replace(/^note\./, '') : null;
		const endPropKey   = config.endDateProp   ? String(config.endDateProp).replace(/^note\./, '')   : null;

		// Mark bar as selected if in selection set
		if (this._selectedPaths.has(entry.file.path)) barEl.addClass('is-selected');

		const canMove   = config.startWritable && config.endWritable;
		const canResizeStart = config.startWritable;
		const canResizeEnd   = config.endWritable;
		const canEdit   = canMove || canResizeStart || canResizeEnd;

		if (startPropKey && endPropKey) {
			// Resize handles — only shown for writable edges
			if (canResizeStart) barEl.createDiv({ cls: 'bases-timeline-bar-handle is-start' });
			if (canResizeEnd)   barEl.createDiv({ cls: 'bases-timeline-bar-handle is-end' });
			if (!canEdit) barEl.addClass('is-readonly');

			// Single mousedown on the bar — detect drag type from click position relative to bar
			barEl.addEventListener('mousedown', e => {
				e.preventDefault();
				this.containerEl.focus();

				// Shift+click: toggle selection (always allowed)
				if (e.shiftKey) {
					if (this._selectedPaths.has(entry.file.path)) {
						this._selectedPaths.delete(entry.file.path);
						barEl.removeClass('is-selected');
					} else {
						this._selectedPaths.add(entry.file.path);
						barEl.addClass('is-selected');
					}
					return;
				}

				if (!this._selectedPaths.has(entry.file.path)) this._clearSelection();
				if (!canEdit) return; // read-only bar — no drag

				const barRect = barEl.getBoundingClientRect();
				const barWidth = barRect.width || 1;
				const clickX = e.clientX - barRect.left;
				const EDGE = Math.min(10, barWidth * 0.3);
				let type: DragState['type'];
				if (clickX <= EDGE && canResizeStart) {
					type = 'resize-start';
				} else if (clickX >= barWidth - EDGE && canResizeEnd) {
					type = 'resize-end';
				} else if (canMove) {
					type = 'move';
				} else {
					return; // no valid drag type
				}
				this._startDrag(type, barEl, entry.file.path, startPropKey, endPropKey,
					dates!.start, dates!.end, e.clientX, min, total);
			});

			// Right-click context menu
			barEl.addEventListener('contextmenu', (e: MouseEvent) => {
				e.preventDefault();
				this._showContextMenu(e, entry, startPropKey, endPropKey, dates!.start, dates!.end, canEdit, config.startWritable, config.endWritable);
			});
		}
	}

	// ─── Navigation ──────────────────────────────────────────────────────────

	private _scrollToDate(date: Date): void {
		const scroller = this._scrollerEl;
		const min = this._rangeMin;
		const max = this._rangeMax;
		const config = this._lastConfig;
		if (!scroller || !min || !max || !config) return;

		const total = max.getTime() - min.getTime();
		if (total === 0) return;

		const target = new Date(date); target.setHours(0, 0, 0, 0);
		const ratio = (target.getTime() - min.getTime()) / total;
		const trackWidth = scroller.scrollWidth - config.frozenWidth;
		const scrollLeft = config.frozenWidth + ratio * trackWidth - scroller.clientWidth / 2;
		scroller.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' });
	}

	/** Returns the Obsidian metadata type for a frontmatter property name, e.g. 'date', 'number', 'checkbox'. */
	private _getPropType(propKey: string): string {
		try {
			const mtm = (this.app as any).metadataTypeManager;
			if (!mtm) return 'text';
			const info = mtm.properties?.[propKey];
			// Obsidian stores type as `widget` on the property info object
			return info?.widget ?? info?.type ?? 'text';
		} catch {
			return 'text';
		}
	}

	/** Show a floating date picker popover anchored to a prop cell for editing date/datetime props. */
	private _showPropDatePicker(
		anchor: HTMLElement,
		filePath: string,
		propKey: string,
		propType: string,
		currentValue: string,
		onSave: (newVal: string) => void,
	): void {
		// Remove any existing prop date picker
		document.getElementById('tl-prop-date-popover')?.remove();

		const isDatetime = propType === 'datetime';
		const popover = document.body.createDiv({ attr: { id: 'tl-prop-date-popover' }, cls: 'bases-timeline-jump-popover tl-prop-date-popover' });
		const rect = anchor.getBoundingClientRect();
		popover.style.top = `${rect.bottom + 4}px`;
		popover.style.left = `${rect.left}px`;

		const input = popover.createEl('input', { type: isDatetime ? 'datetime-local' : 'date' });
		// Pre-fill with current value (ISO date string or YYYY-MM-DD)
		if (currentValue) {
			try {
				const d = new Date(currentValue);
				if (!isNaN(d.getTime())) {
					input.value = isDatetime
						? d.toISOString().slice(0, 16)
						: d.toISOString().slice(0, 10);
				} else {
					input.value = currentValue;
				}
			} catch { input.value = currentValue; }
		}

		const save = async () => {
			const raw = input.value;
			const file = this.app.vault.getFileByPath(filePath);
			if (!raw) {
				// Empty = user cleared the date
				if (file) {
					await this.app.fileManager.processFrontMatter(file, fm => { delete fm[propKey]; });
					onSave('');
				}
				popover.remove();
				return;
			}
			const d = new Date(raw + (isDatetime ? '' : 'T00:00:00'));
			const stored = isDatetime ? d.toISOString() : raw;
			if (file) {
				await this.app.fileManager.processFrontMatter(file, fm => { fm[propKey] = stored; });
				onSave(raw);
			}
			popover.remove();
		};

		// Auto-save on date change, close on Escape
		input.addEventListener('change', () => { void save(); });
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') { popover.remove(); }
		});

		const dismiss = (e: MouseEvent) => {
			if (!popover.contains(e.target as Node)) {
				popover.remove();
				document.removeEventListener('mousedown', dismiss);
			}
		};
		setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
		input.focus();
	}

	private _showJumpToDate(anchor: HTMLElement, evt: MouseEvent): void {
		const existing = document.getElementById('tl-jump-popover');
		if (existing) { existing.remove(); return; }

		const popover = document.body.createDiv({ attr: { id: 'tl-jump-popover' }, cls: 'bases-timeline-jump-popover' });
		const rect = anchor.getBoundingClientRect();
		popover.style.top  = `${rect.bottom + 6}px`;
		popover.style.left = `${rect.left}px`;

		const input = popover.createEl('input', { type: 'date' });
		input.value = this._fmtDate(new Date());

		const go = popover.createEl('button', { cls: 'mod-cta', text: 'Go' });
		go.addEventListener('click', () => {
			const d = new Date(input.value + 'T00:00:00');
			if (!isNaN(d.getTime())) this._scrollToDate(d);
			popover.remove();
		});
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') go.click();
			if (e.key === 'Escape') popover.remove();
		});

		const dismiss = (e: MouseEvent) => {
			if (!popover.contains(e.target as Node)) { popover.remove(); document.removeEventListener('mousedown', dismiss); }
		};
		setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
		input.focus();
	}

	/** Write-back handler when a row is dropped onto a group header */
	private async _dropToGroup(entryPath: string, fromGroupValue: string, toGroupValue: string, hintProp: string | null): Promise<void> {
		if (fromGroupValue === toGroupValue) return;

		const file = this.app.vault.getFileByPath(entryPath);
		if (!file) return;

		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};

		// Determine the group-by property:
		// 1. Hint from config (usually null since Bases doesn't expose it).
		// 2. Match the entry's own frontmatter value against its current group label.
		//    Works when the entry is in a named group (non-empty value).
		// 3. Fallback for "Ungrouped" entries: scan entries in other named groups
		//    to identify which field holds the group key value.
		let groupByProp = hintProp;

		// Helper: strip Bases' `note.` namespace prefix → actual YAML frontmatter key.
		// Bases stores property IDs as `note.horizon` internally, but the YAML key is `horizon`.
		const normaliseKey = (k: string) => k.startsWith('note.') ? k.slice(5) : k;

		// Normalise the hint too — it comes directly from Bases config and already has the prefix
		if (groupByProp) groupByProp = normaliseKey(groupByProp);

		if (!groupByProp && fromGroupValue !== 'Ungrouped') {
			for (const [k, v] of Object.entries(fm)) {
				if (k === 'position') continue;
				if (String(v ?? '') === fromGroupValue) { groupByProp = normaliseKey(k); break; }
			}
		}

		if (!groupByProp) {
			// Scan named groups to find which frontmatter field matches their key
			outer: for (const grp of this.data.groupedData) {
				if (!grp.hasKey()) continue;
				const grpLabel = grp.key?.toString() ?? '';
				if (!grpLabel) continue;
				for (const candidate of grp.entries.slice(0, 5)) {
					const cfm = this.app.metadataCache.getFileCache(candidate.file)?.frontmatter ?? {};
					for (const [k, v] of Object.entries(cfm)) {
						if (k === 'position') continue;
						if (String(v ?? '') === grpLabel) { groupByProp = normaliseKey(k); break outer; }
					}
				}
			}
		}

		if (!groupByProp) {
			new Notice('Timeline: could not determine group property — drag-to-group requires at least one other non-empty group');
			return;
		}

		const oldValue = String(fm[groupByProp] ?? '');

		this._pushUndo([{
			path: entryPath,
			startKey: groupByProp,
			endKey: '__group__',
			before: { start: oldValue, end: '__group__' },
			after:  { start: toGroupValue, end: '__group__' },
		}]);

		try {
			await this.app.fileManager.processFrontMatter(file, (fmData) => {
				delete fmData[`note.${groupByProp!}`];
				if (toGroupValue === 'Ungrouped') {
					delete fmData[groupByProp!]; // remove property entirely → note becomes ungrouped
				} else {
					fmData[groupByProp!] = toGroupValue;
				}
			});
		} catch (err) {
			new Notice(`Timeline: failed to write frontmatter — ${err}`);
		}
	}

	private async _exportPng(): Promise<void> {
		const el = this.bodyEl as HTMLElement;
		try {
			const html2canvas = (await import('html2canvas')).default;
			const canvas = await html2canvas(el, {
				backgroundColor: getComputedStyle(el).backgroundColor || '#fff',
				scale: window.devicePixelRatio || 1,
				useCORS: true,
			});
			const dataUrl = canvas.toDataURL('image/png');
			const base64 = dataUrl.split(',')[1] || '';
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			const filePath = normalizePath(`timeline-${Date.now()}.png`);
			await this.app.vault.adapter.writeBinary(filePath, bytes.buffer as ArrayBuffer);
			new Notice(`Saved: ${filePath}`);
		} catch (err) {
			console.error('[Timeline] Export failed:', err);
			new Notice('Export failed — check console.');
		}
	}

	// ─── Selection ───────────────────────────────────────────────────────────

	private _clearSelection(): void {
		this._selectedPaths.clear();
		this.bodyEl.querySelectorAll('.bases-timeline-bar.is-selected')
			.forEach(el => el.removeClass('is-selected'));
	}

	// ─── Context menu ─────────────────────────────────────────────────────────

	private _showContextMenu(
		e: MouseEvent,
		entry: BasesEntry,
		startKey: string,
		endKey: string,
		currentStart: Date,
		currentEnd: Date,
		canEdit = true,
		startWritable = true,
		endWritable = true
	): void {
		const menu = new Menu();

		menu.addItem(item => item
			.setTitle('Open note')
			.setIcon('external-link')
			.onClick(() => this.app.workspace.openLinkText(entry.file.path, '', e.ctrlKey || e.metaKey)));

		menu.addSeparator();

		if (canEdit) {
			menu.addItem(item => item
				.setTitle('Edit dates…')
				.setIcon('calendar')
				.onClick(() => this._showEditDatesPopover(e, entry, startKey, endKey, currentStart, currentEnd, startWritable, endWritable)));
		}

		menu.addItem(item => item
			.setTitle('Duplicate')
			.setIcon('copy')
			.onClick(async () => {
				const base = entry.file.basename;
				const dir  = entry.file.parent?.path ?? '';
				let newPath = dir ? `${dir}/${base} copy.md` : `${base} copy.md`;
				let n = 1;
				while (await this.app.vault.adapter.exists(newPath)) {
					newPath = dir ? `${dir}/${base} copy ${++n}.md` : `${base} copy ${n}.md`;
				}
				await this.app.vault.copy(entry.file, newPath);
			}));

		menu.addSeparator();

		if (canEdit) menu.addItem(item => item
			.setTitle('Clear dates')
			.setIcon('calendar-x')
			.onClick(async () => {
				const oldStart = this._fmtDate(currentStart);
				const oldEnd   = this._fmtDate(currentEnd);
				this._pushUndo([{
					path: entry.file.path, startKey, endKey,
					before: { start: oldStart, end: oldEnd },
					after:  { start: '', end: '' },
				}]);
				await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
					delete fm[startKey];
					delete fm[endKey];
				});
			}));

		menu.addItem(item => item
			.setTitle('Delete')
			.setIcon('trash')
			.onClick(() => {
				new ConfirmDeleteModal(this.app, entry.file.basename, async () => {
					await this.app.vault.trash(entry.file, true);
				}).open();
			}));

		menu.showAtMouseEvent(e);
	}

	private _showEditDatesPopover(
		e: MouseEvent,
		entry: BasesEntry,
		startKey: string,
		endKey: string,
		currentStart: Date,
		currentEnd: Date,
		startWritable = true,
		endWritable = true
	): void {
		const existing = document.getElementById('tl-edit-dates-popover');
		if (existing) existing.remove();

		const pop = document.body.createDiv({ attr: { id: 'tl-edit-dates-popover' }, cls: 'bases-timeline-jump-popover' });
		pop.style.top  = `${e.clientY + 6}px`;
		pop.style.left = `${e.clientX}px`;

		pop.createEl('label', { text: 'Start', cls: 'tl-pop-label' });
		const startInput = pop.createEl('input', { type: 'date' });
		startInput.value = this._fmtDate(currentStart);
		if (!startWritable) { startInput.disabled = true; startInput.title = 'Set by a formula — cannot be edited here'; }

		pop.createEl('label', { text: 'End', cls: 'tl-pop-label' });
		const endInput = pop.createEl('input', { type: 'date' });
		endInput.value = this._fmtDate(currentEnd);
		if (!endWritable) { endInput.disabled = true; endInput.title = 'Set by a formula — cannot be edited here'; }

		const save = pop.createEl('button', { cls: 'mod-cta', text: 'Save' });
		save.addEventListener('click', async () => {
			pop.remove();
			const newStart = startInput.value;
			const newEnd   = endInput.value;
			if (!newStart || !newEnd) return;
			const before = { start: this._fmtDate(currentStart), end: this._fmtDate(currentEnd) };
			const file = this.app.vault.getFileByPath(entry.file.path);
			if (!file) return;
			await this.app.fileManager.processFrontMatter(file, fm => {
				fm[startKey] = newStart;
				fm[endKey]   = newEnd;
			});
			this._pushUndo([{ path: entry.file.path, startKey, endKey, before, after: { start: newStart, end: newEnd } }]);
		});

		startInput.addEventListener('click', e2 => e2.stopPropagation());
		endInput.addEventListener('click',   e2 => e2.stopPropagation());
		startInput.addEventListener('mousedown', e2 => e2.stopPropagation());
		endInput.addEventListener('mousedown',   e2 => e2.stopPropagation());

		const dismiss = (ev: MouseEvent) => {
			if (!pop.contains(ev.target as Node)) { pop.remove(); document.removeEventListener('mousedown', dismiss); }
		};
		setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
	}

	// ─── Undo / redo ─────────────────────────────────────────────────────────

	private _pushUndo(entries: UndoRecord['entries']): void {
		this._undoStack.push({ entries });
		this._redoStack = [];
		if (this._undoStack.length > 50) this._undoStack.shift();
		this._refreshUndoRedoState();
	}

	private _refreshUndoRedoState(): void {
		if (this._undoBtn) this._undoBtn.disabled = this._undoStack.length === 0;
		if (this._redoBtn) this._redoBtn.disabled = this._redoStack.length === 0;
	}

	private async _applyUndoRecord(record: UndoRecord, direction: 'undo' | 'redo'): Promise<void> {
		for (const e of record.entries) {
			const file = this.app.vault.getFileByPath(e.path);
			if (!file) continue;
			const target = direction === 'undo' ? e.before : e.after;
			await this.app.fileManager.processFrontMatter(file, fm => {
				// Group-change records use endKey='__group__' sentinel
				if (e.endKey === '__group__') {
					fm[e.startKey] = target.start;
				} else {
					fm[e.startKey] = target.start;
					fm[e.endKey]   = target.end;
				}
			});
		}
	}

	private _onKeyDown(e: KeyboardEvent): void {
		const ctrl = e.ctrlKey || e.metaKey;
		if (ctrl && e.key === 'z' && !e.shiftKey) {
			e.preventDefault();
			const record = this._undoStack.pop();
			if (!record) return;
			this._redoStack.push(record);
			void this._applyUndoRecord(record, 'undo');
			this._refreshUndoRedoState();
		} else if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
			e.preventDefault();
			const record = this._redoStack.pop();
			if (!record) return;
			this._undoStack.push(record);
			void this._applyUndoRecord(record, 'redo');
			this._refreshUndoRedoState();
		} else if (e.key === 'Escape') {
			this._clearSelection();
		}
	}

	// ─── End navigation ───────────────────────────────────────────────────────

	// ─── Drag & resize ───────────────────────────────────────────────────────

	private _localMidnight(d: Date): Date { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; }

	private _fmtDate(d: Date): string {
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	private _startDrag(
		type: DragState['type'],
		barEl: HTMLElement,
		entryPath: string,
		startPropKey: string,
		endPropKey: string,
		origStart: Date,
		origEnd: Date,
		mouseX: number,
		rangeMin: Date,
		totalMs: number
	): void {
		const trackEl = barEl.parentElement!;
		const lmStart = this._localMidnight(origStart);
		const lmEnd   = this._localMidnight(origEnd);
		this._dragState = {
			type, barEl, entryPath, startPropKey, endPropKey,
			origStart: lmStart,
			origEnd:   lmEnd,
			pendingStart: new Date(lmStart),
			pendingEnd:   new Date(lmEnd),
			mouseStartX: mouseX,
			trackWidth: trackEl.offsetWidth || 1,
			rangeMin, totalMs,
		};
		barEl.addClass('is-dragging');
		document.body.style.cursor = type === 'move' ? 'grabbing' : 'ew-resize';
		(document.body.style as CSSStyleDeclaration & { userSelect: string }).userSelect = 'none';

		this._dragTooltipEl = document.body.createDiv({ cls: 'bases-timeline-drag-tooltip' });
		this._refreshTooltip(this._dragState.origStart, this._dragState.origEnd);
	}

	private _refreshTooltip(start: Date, end: Date): void {
		if (!this._dragTooltipEl) return;
		const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
		this._dragTooltipEl.textContent = `${fmt.format(start)} → ${fmt.format(end)}`;
	}

	private _onDragMove(e: MouseEvent): void {
		// ── Draw mode (click-drag to set dates on a dateless row) ───────────
		if (this._draw) {
			const d     = this._draw;
			const rect  = d.trackEl.getBoundingClientRect();
			const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			const curDate = this._localMidnight(new Date(d.rangeMin.getTime() + pct * d.totalMs));
			const start = curDate < d.anchorDate ? curDate : d.anchorDate;
			const end   = curDate < d.anchorDate ? d.anchorDate : curDate;
			const startPct = ((start.getTime() - d.rangeMin.getTime()) / d.totalMs) * 100;
			const endPct   = ((end.getTime() + 86400000 - d.rangeMin.getTime()) / d.totalMs) * 100;
			d.ghostEl.style.left  = `${startPct}%`;
			d.ghostEl.style.width = `${Math.max(endPct - startPct, 0.5)}%`;
			return;
		}
		if (!this._dragState) return;
		const s = this._dragState;

		const deltaPx = e.clientX - s.mouseStartX;
		const deltaDays = Math.round((deltaPx / s.trackWidth) * (s.totalMs / 86400000));
		const dayMs = 86400000;
		const minWidthDays = 1; // bar never narrower than 1 day

		let newStart: Date, newEnd: Date;

		if (s.type === 'move') {
			newStart = this._localMidnight(new Date(s.origStart.getTime() + deltaDays * dayMs));
			newEnd   = this._localMidnight(new Date(s.origEnd.getTime()   + deltaDays * dayMs));
			const leftPct = ((newStart.getTime() - s.rangeMin.getTime()) / s.totalMs) * 100;
			s.barEl.style.left = `${leftPct}%`;
			// width unchanged (duration preserved)

		} else if (s.type === 'resize-end') {
			newStart = new Date(s.origStart);
			const rawEnd = this._localMidnight(new Date(s.origEnd.getTime() + deltaDays * dayMs));
			// end >= start + 1 day minimum
			const minEnd = new Date(s.origStart.getTime() + (minWidthDays - 1) * dayMs);
			newEnd = rawEnd < minEnd ? minEnd : rawEnd;
			const excl = new Date(newEnd); excl.setDate(excl.getDate() + 1);
			const widthMs = Math.max(minWidthDays * dayMs, excl.getTime() - newStart.getTime());
			s.barEl.style.width = `${(widthMs / s.totalMs) * 100}%`;
			// left unchanged

		} else { // resize-start
			const rawStart = this._localMidnight(new Date(s.origStart.getTime() + deltaDays * dayMs));
			// start <= end - 1 day minimum
			const maxStart = new Date(s.origEnd.getTime() - (minWidthDays - 1) * dayMs);
			newStart = rawStart > maxStart ? maxStart : rawStart;
			newEnd = new Date(s.origEnd);
			const leftPct = ((newStart.getTime() - s.rangeMin.getTime()) / s.totalMs) * 100;
			const excl = new Date(newEnd); excl.setDate(excl.getDate() + 1);
			const widthMs = Math.max(minWidthDays * dayMs, excl.getTime() - newStart.getTime());
			s.barEl.style.left  = `${leftPct}%`;
			s.barEl.style.width = `${(widthMs / s.totalMs) * 100}%`;
			// right edge stays fixed
		}

		// Store dates in state — used directly on mouseup (avoids CSS precision loss)
		s.pendingStart = new Date(newStart);
		s.pendingEnd   = new Date(newEnd);

		this._refreshTooltip(newStart, newEnd);
		if (this._dragTooltipEl) {
			this._dragTooltipEl.style.left = `${e.clientX + 14}px`;
			this._dragTooltipEl.style.top  = `${e.clientY - 32}px`;
		}
	}

	private async _onDragEnd(e: MouseEvent): Promise<void> {
		// ── Draw mode finish ─────────────────────────────────────────────────
		if (this._draw) {
			const d    = this._draw;
			this._draw = null;
			const rect = d.trackEl.getBoundingClientRect();
			const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			const curDate = this._localMidnight(new Date(d.rangeMin.getTime() + pct * d.totalMs));
			const start = curDate < d.anchorDate ? curDate : d.anchorDate;
			const end   = curDate < d.anchorDate ? d.anchorDate : curDate;
			d.ghostEl.remove();

			const startStr = this._fmtDate(start);
			const endStr   = this._fmtDate(end);

			const file = this.app.vault.getFileByPath(d.entryPath);
			if (file) {
				this._pushUndo([{
					path: d.entryPath, startKey: d.startKey, endKey: d.endKey,
					before: { start: '', end: '' },
					after:  { start: startStr, end: endStr },
				}]);
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					fm[d.startKey] = startStr;
					fm[d.endKey]   = endStr;
				});
			}
			return;
		}
		if (!this._dragState) return;
		const s = this._dragState;
		this._dragState = null;

		s.barEl.removeClass('is-dragging');
		document.body.style.cursor = '';
		(document.body.style as CSSStyleDeclaration & { userSelect: string }).userSelect = '';
		this._dragTooltipEl?.remove();
		this._dragTooltipEl = null;

		// Use pendingStart/End tracked during drag — do NOT reconstruct from CSS
		const newStart = s.pendingStart;
		const newEnd   = s.pendingEnd;
		const deltaMs  = newStart.getTime() - s.origStart.getTime();

		// Build list of bars to update: the dragged bar + any other selected bars (move only)
		const toUpdate: UndoRecord['entries'] = [];

		// Primary bar
		const primaryFile = this.app.vault.getFileByPath(s.entryPath);
		if (primaryFile) {
			const before = { start: this._fmtDate(s.origStart), end: this._fmtDate(s.origEnd) };
			const after  = { start: this._fmtDate(newStart),    end: this._fmtDate(newEnd) };
			toUpdate.push({ path: s.entryPath, startKey: s.startPropKey, endKey: s.endPropKey, before, after });
			try {
				await this.app.fileManager.processFrontMatter(primaryFile, fm => {
					fm[s.startPropKey] = after.start;
					fm[s.endPropKey]   = after.end;
				});
			} catch (err) { console.error('[Timeline] Failed to update frontmatter:', err); }
		}

		// Bulk-move other selected bars (only for 'move' type)
		if (s.type === 'move' && this._selectedPaths.size > 1 && deltaMs !== 0) {
			const otherBars = Array.from(
				this.bodyEl.querySelectorAll<HTMLElement>('.bases-timeline-bar.is-selected')
			).filter(el => {
				const row = el.closest('[data-entry-path]') as HTMLElement | null;
				return row && row.getAttribute('data-entry-path') !== s.entryPath;
			});

			for (const barEl of otherBars) {
				const rowEl = barEl.closest('[data-entry-path]') as HTMLElement | null;
				const path = rowEl?.getAttribute('data-entry-path');
				if (!path) continue;
				const file = this.app.vault.getFileByPath(path);
				if (!file) continue;

				const fmCache = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fmCache) continue;
				const oldStartStr = fmCache[s.startPropKey];
				const oldEndStr   = fmCache[s.endPropKey];
				if (!oldStartStr || !oldEndStr) continue;

				const oldS = new Date(oldStartStr + 'T00:00:00'); oldS.setHours(0,0,0,0);
				const oldE = new Date(oldEndStr   + 'T00:00:00'); oldE.setHours(0,0,0,0);
				const newS = new Date(oldS.getTime() + deltaMs);
				const newE = new Date(oldE.getTime() + deltaMs);

				const before = { start: this._fmtDate(oldS), end: this._fmtDate(oldE) };
				const after  = { start: this._fmtDate(newS), end: this._fmtDate(newE) };
				toUpdate.push({ path, startKey: s.startPropKey, endKey: s.endPropKey, before, after });

				await this.app.fileManager.processFrontMatter(file, fm => {
					fm[s.startPropKey] = after.start;
					fm[s.endPropKey]   = after.end;
				});
			}
		}

		if (toUpdate.length > 0) this._pushUndo(toUpdate);
	}

	// ─── End drag & resize ───────────────────────────────────────────────────

	private getEntryLabel(entry: BasesEntry, labelProp: BasesPropertyId | null): string {
		if (labelProp) {
			const value = entry.getValue(labelProp);
			if (value && value.isTruthy()) return value.toString();
		}
		return entry.file.basename || entry.file.name.replace(/\.md$/i, '');
	}

	private getEntryDates(entry: BasesEntry, startProp: BasesPropertyId | null, endProp: BasesPropertyId | null): { start: Date; end: Date; isPoint: boolean } | null {
		if (!startProp || !endProp) return null;

		const startValue = entry.getValue(startProp);
		const endValue = entry.getValue(endProp);
		const start = this.parseDateValue(startValue);
		let end = this.parseDateValue(endValue);

		if (!start) return null;

		const hasEndValue = Boolean(endValue && endValue.isTruthy());
		if (hasEndValue && !end) {
			// End date exists but is invalid/unparseable: do not force point rendering.
			return null;
		}

		const isPoint = !hasEndValue;
		if (!end) end = new Date(start.getTime());
		if (start.getTime() > end.getTime()) return null;

		return { start, end, isPoint };
	}

	/** Parse a raw frontmatter value (string | number | Date) into a Date, or null if invalid. */
	private parseRawFrontmatterDate(raw: unknown): Date | null {
		if (raw == null || raw === '' || raw === false) return null;
		const ms = raw instanceof Date ? raw.getTime()
			: typeof raw === 'number' ? raw
			: typeof raw === 'string' ? Date.parse(raw)
			: NaN;
		return Number.isNaN(ms) ? null : new Date(ms);
	}

	private parseDateValue(value: Value | null): Date | null {
		if (!value || !value.isTruthy()) return null;

		if (value instanceof DateValue) {
			const parsed = Date.parse(value.toString());
			return Number.isNaN(parsed) ? null : new Date(parsed);
		}

		const text = value.toString();
		const parsed = Date.parse(text);
		if (!Number.isNaN(parsed)) return new Date(parsed);

		const dateValue = DateValue.parseFromString(text);
		if (dateValue) {
			const parsedDate = Date.parse(dateValue.toString());
			return Number.isNaN(parsedDate) ? null : new Date(parsedDate);
		}

		return null;
	}

	private getTimelineRange(entries: BasesEntry[], startProp: BasesPropertyId, endProp: BasesPropertyId, config: TimelineConfig): { min: Date; max: Date } | null {
		let min: Date | null = null;
		let max: Date | null = null;

		for (const entry of entries) {
			const dates = this.getEntryDates(entry, startProp, endProp);
			if (!dates) continue;
			if (!min || dates.start < min) min = dates.start;
			if (!max || dates.end > max) max = dates.end;
		}

		if (!min || !max) return null;

		min = this.snapStartToScale(min, config.timeScale, config.weekStart);
		max = this.snapEndToScale(max, config.timeScale, config.weekStart);

		// Padding so bars/labels don't sit flush at edges
		const weekMs = 7 * 24 * 60 * 60 * 1000;
		if (config.timeScale === 'week') {
			// One week before and after for week scale
			min = new Date(min.getTime() - weekMs);
			max = new Date(max.getTime() + weekMs);
		} else if (config.timeScale !== 'day') {
			max = new Date(max.getTime() + weekMs);
		}

		return { min, max };
	}

	private getScaleZoomFactor(scale: string): number {
		if (scale === 'day') return 2.4;
		if (scale === 'week') return 3.1;
		if (scale === 'month') return 1.15;
		if (scale === 'quarter') return 1;
		if (scale === 'year') return 0.9;
		return 1;
	}

	private snapStartToScale(date: Date, scale: string, weekStart: 'monday' | 'sunday' = 'monday'): Date {
		const d = new Date(date);
		d.setHours(0, 0, 0, 0);
		if (scale === 'week') {
			const day = d.getDay();
			const shift = weekStart === 'sunday' ? day : (day === 0 ? 6 : day - 1);
			d.setDate(d.getDate() - shift);
		} else if (scale === 'month') {
			d.setDate(1);
		} else if (scale === 'quarter') {
			const qStart = Math.floor(d.getMonth() / 3) * 3;
			d.setMonth(qStart, 1);
		} else if (scale === 'year') {
			d.setMonth(0, 1);
		}
		return d;
	}

	private snapEndToScale(date: Date, scale: string, weekStart: 'monday' | 'sunday' = 'monday'): Date {
		const d = new Date(date);
		d.setHours(23, 59, 59, 999);
		if (scale === 'week') {
			const day = d.getDay();
			const endShift = weekStart === 'sunday' ? (6 - day) : ((day === 0 ? 0 : 7 - day));
			d.setDate(d.getDate() + endShift);
		} else if (scale === 'month') {
			d.setMonth(d.getMonth() + 1, 0);
		} else if (scale === 'quarter') {
			const qStart = Math.floor(d.getMonth() / 3) * 3;
			d.setMonth(qStart + 3, 0);
		} else if (scale === 'year') {
			d.setMonth(11, 31);
		}
		return d;
	}

	private formatTickLabel(date: Date, scale: string, formatter: Intl.DateTimeFormat): string {
		if (scale === 'week') {
			const w = this.getIsoWeekNumber(date);
			return `W${w}`;
		}
		if (scale === 'quarter') {
			const quarter = Math.floor(date.getMonth() / 3) + 1;
			return `Q${quarter}`;
		}
		return formatter.format(date);
	}

	private getIsoWeekNumber(date: Date): number {
		const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
		d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
		const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
		return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
	}

	private getAxisFormatter(min: Date, max: Date, scale?: string): Intl.DateTimeFormat {
		if (scale === 'day') {
			return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
		}
		if (scale === 'week') {
			return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
		}
		if (scale === 'month') {
			return new Intl.DateTimeFormat(undefined, { month: 'short' });
		}
		if (scale === 'quarter') {
			return new Intl.DateTimeFormat(undefined, { year: 'numeric' });
		}
		if (scale === 'year') {
			return new Intl.DateTimeFormat(undefined, { year: 'numeric' });
		}

		const totalDays = Math.max(1, Math.round((max.getTime() - min.getTime()) / (1000 * 60 * 60 * 24)));
		if (totalDays > 365 * 2) {
			return new Intl.DateTimeFormat(undefined, { year: 'numeric' });
		}
		if (totalDays > 90) {
			return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
		}
		if (totalDays > 14) {
			return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
		}
		return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
	}

	private getUniqueColorValues(colorProp: BasesPropertyId): string[] {
		const values = new Set<string>();
		for (const entry of this.data.data) {
			const value = entry.getValue(colorProp);
			if (!value || !value.isTruthy()) continue;
			values.add(value.toString());
		}
		return Array.from(values).sort((a, b) => a.localeCompare(b));
	}

	/** Collect all unique values used for a frontmatter key across the entire vault. */
	private getVaultValuesForProp(propKey: string): string[] {
		const values = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const v = fm[propKey];
			if (v == null || v === '') continue;
			if (Array.isArray(v)) {
				v.forEach(item => item != null && values.add(String(item)));
			} else {
				values.add(String(v));
			}
		}
		return Array.from(values).sort((a, b) => a.localeCompare(b));
	}

	private ensureColorMap(colorMap: Record<string, string>, values: string[]): { colorMap: Record<string, string>; changed: boolean } {
		let changed = false;
		const map = { ...colorMap };
		values.forEach((value, index) => {
			if (!map[value]) {
				map[value] = DEFAULT_COLORS[index % DEFAULT_COLORS.length];
				changed = true;
			}
		});
		return { colorMap: map, changed };
	}

	private getEntryColor(entry: BasesEntry, colorProp: BasesPropertyId | null, colorMap: Record<string, string>): string | null {
		if (!colorProp) return null;
		const value = entry.getValue(colorProp);
		if (!value || !value.isTruthy()) return null;
		const key = value.toString();
		return colorMap[key] || null;
	}
}

class ConfirmDeleteModal extends Modal {
	private fileName: string;
	private onConfirm: () => void;

	constructor(app: import('obsidian').App, fileName: string, onConfirm: () => void) {
		super(app);
		this.fileName = fileName;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('tl-confirm-delete-modal');

		contentEl.createEl('h2', { text: 'Delete note' });
		contentEl.createEl('p', {
			text: `Are you sure you want to delete "${this.fileName}"? This will move it to the system trash.`,
		});

		const btnRow = contentEl.createDiv({ cls: 'tl-confirm-delete-buttons' });

		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const deleteBtn = btnRow.createEl('button', { text: 'Delete', cls: 'mod-warning' });
		deleteBtn.addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});

		// Focus the cancel button by default (safer)
		cancelBtn.focus();
	}

	onClose() {
		this.contentEl.empty();
	}
}

import {
	BasesEntry,
	BasesAllOptions,
	BasesEntryGroup,
	BasesPropertyId,
	BasesPropertyOption,
	BasesView,
	BasesViewConfig,
	DateValue,
	NullValue,
	QueryController,
	Value,
	debounce,
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
}

const LABEL_COLUMN_WIDTH_PX = 175;
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
}

export class TimelineView extends BasesView {
	type = 'timeline';
	containerEl: HTMLElement;
	headerEl: HTMLElement;
	bodyEl: HTMLElement;
	controlsEl: HTMLElement;
	plugin: TimelinePlugin;
	private _renderSeq = 0; // incremented on each render; async renders check this to self-cancel

	private _dragState: DragState | null = null;
	private _dragTooltipEl: HTMLElement | null = null;
	private _boundMouseMove!: (e: MouseEvent) => void;
	private _boundMouseUp!: (e: MouseEvent) => void;

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
		document.addEventListener('mousemove', this._boundMouseMove);
		document.addEventListener('mouseup', this._boundMouseUp);
		this.render();
	}

	onunload(): void {
		document.removeEventListener('mousemove', this._boundMouseMove);
		document.removeEventListener('mouseup', this._boundMouseUp);
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



		// Right side: config toggle
		const rightEl = this.headerEl.createDiv({ cls: 'bases-timeline-header-right' });
		const toggle = rightEl.createEl('button', { cls: 'bases-timeline-controls-toggle' });
		setIcon(toggle, 'settings');
		toggle.createSpan({ cls: 'bases-timeline-controls-toggle-label', text: 'Config' });
		toggle.setAttribute('aria-label', 'Configuration');
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

		if (hasFixedWindow) {
			// Fixed window: canvas can be set up immediately (min/max known from config).
			// All entry processing + row rendering is deferred async to keep the UI responsive.
			const min = new Date(rangeStartMs as number);
			min.setHours(0, 0, 0, 0);
			const max = new Date(min.getTime() + (rangePresetDays as number) * 24 * 60 * 60 * 1000);
			max.setHours(23, 59, 59, 999);

			// Render canvas structure synchronously — visible immediately
			const scrollerEl = this.bodyEl.createDiv({ cls: 'bases-timeline-scroller' });
			const canvasEl = scrollerEl.createDiv({ cls: 'bases-timeline-canvas' });
			const ticks = this.getTicksForScale(min, max, config.timeScale, config.weekStart);
			const zoom = Math.max(config.zoom, 1);
			if (config.timeScale === 'day') {
				canvasEl.style.width = `${config.labelColWidth + Math.max(900, ticks.length * 44 * zoom)}px`;
			} else if (config.timeScale === 'week') {
				canvasEl.style.width = `${config.labelColWidth + Math.max(900, ticks.length * 60 * zoom)}px`;
			} else if (config.timeScale === 'month') {
				canvasEl.style.width = `${config.labelColWidth + Math.max(900, ticks.length * 55 * zoom)}px`;
			} else {
				canvasEl.style.width = `calc(${config.labelColWidth}px + ${zoom * this.getScaleZoomFactor(config.timeScale) * 100}%)`;
			}
			this.renderTimeAxis(canvasEl, min, max, config, ticks);
			this.renderGridLines(canvasEl, ticks, min, max, config.timeScale, config.weekStart, config.labelColWidth);
			if (config.timeScale === 'day') {
				this.renderTodayMarker(canvasEl, min, max, true, config.labelColWidth);
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

			const scrollerEl = this.bodyEl.createDiv({ cls: 'bases-timeline-scroller' });
			const canvasEl = scrollerEl.createDiv({ cls: 'bases-timeline-canvas' });
			const ticks = this.getTicksForScale(min, max, config.timeScale, config.weekStart);
			const zoom = Math.max(config.zoom, 1);
			const scaleZoom = this.getScaleZoomFactor(config.timeScale);
			if (config.timeScale === 'day') {
				canvasEl.style.width = `${config.labelColWidth + Math.max(900, ticks.length * 44 * zoom)}px`;
			} else if (config.timeScale === 'week') {
				canvasEl.style.width = `${config.labelColWidth + Math.max(900, ticks.length * 60 * zoom)}px`;
			} else if (config.timeScale === 'month') {
				canvasEl.style.width = `${config.labelColWidth + Math.max(900, ticks.length * 55 * zoom)}px`;
			} else {
				canvasEl.style.width = `calc(${config.labelColWidth}px + ${zoom * scaleZoom * 100}%)`;
			}
			this.renderTimeAxis(canvasEl, min, max, config, ticks);
			this.renderGridLines(canvasEl, ticks, min, max, config.timeScale, config.weekStart, config.labelColWidth);
			if (config.timeScale === 'day') {
				this.renderTodayMarker(canvasEl, min, max, true, config.labelColWidth);
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

		// Sticky "Notes" header cell aligned with label column
		const spacerEl = axisEl.createDiv({ cls: 'bases-timeline-axis-spacer' });
		spacerEl.createDiv({ cls: 'bases-timeline-notes-header', text: 'Notes' });
		this.attachResizeHandle(spacerEl, config);

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
			overlayEl.style.left = `${labelColWidth}px`;
			overlayEl.style.width = `calc(100% - ${labelColWidth}px)`;
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
		if (isGrouped) {
			const groupLabel = group.key && !Value.equals(group.key, NullValue.value)
				? group.key.toString()
				: 'Ungrouped';
			containerEl.createDiv({ cls: 'bases-timeline-group', text: groupLabel });
		}

		let rowIndex = 0;
		group.entries.forEach((entry) => {
			const dates = entryDatesCache.get(entry) ?? null;
			// Skip entries entirely outside the render window (no overlap with [min, max])
			if (dates && (dates.end < min || dates.start > max)) return;
			this.renderRow(containerEl, entry, config, min, max, rowIndex % 2 === 0, ticks, entryDatesCache);
			rowIndex++;
		});
	}

	private renderRow(containerEl: HTMLElement, entry: BasesEntry, config: TimelineConfig, min: Date, max: Date, isEven: boolean = false, ticks: Date[], entryDatesCache: Map<BasesEntry, { start: Date; end: Date; isPoint: boolean } | null>): void {
		const rowEl = containerEl.createDiv({ cls: 'bases-timeline-row' });
		if (isEven) rowEl.addClass('is-even');
		rowEl.setAttribute('data-entry-path', entry.file.path);

		const label = this.getEntryLabel(entry, config.labelProp);
		const labelEl = rowEl.createDiv({ cls: 'bases-timeline-label' });
		labelEl.createEl('span', { text: label });

		const trackEl = rowEl.createDiv({ cls: 'bases-timeline-track' });

		const dates = entryDatesCache.get(entry) ?? null;
		if (!dates) {
			rowEl.addClass('is-missing');
			labelEl.addClass('is-missing');
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
		const effectiveDuration = dates.isPoint ? 0 : Math.max(0, endMs - startMs);

		const left = total === 0 ? 0 : (startOffset / total) * 100;
		const width = total === 0 ? 100 : (effectiveDuration / total) * 100;

		const barEl = trackEl.createDiv({ cls: 'bases-timeline-bar' });
		if (dates.isPoint) {
			barEl.addClass('is-point');
		} else if (width < 0.8) {
			barEl.addClass('is-compressed');
		}
		barEl.style.left = `${left}%`;
		barEl.style.width = `${width}%`;

		const color = this.getEntryColor(entry, config.colorProp, config.colorMap);
		if (color) {
			barEl.style.backgroundColor = color;
		}

		barEl.setAttribute('title', `${label} (${dates.start.toLocaleDateString()} → ${dates.end.toLocaleDateString()})`);

		// Drag & resize — only when we know which frontmatter keys to write
		const startPropKey = config.startDateProp ? String(config.startDateProp).replace(/^note\./, '') : null;
		const endPropKey   = config.endDateProp   ? String(config.endDateProp).replace(/^note\./, '')   : null;

		if (startPropKey && endPropKey && !dates.isPoint) {
			// Visual-only resize handles (no event listeners — cursor comes from CSS)
			barEl.createDiv({ cls: 'bases-timeline-bar-handle is-start' });
			barEl.createDiv({ cls: 'bases-timeline-bar-handle is-end' });

			// Single mousedown on the bar — detect drag type from click position relative to bar
			barEl.addEventListener('mousedown', e => {
				e.preventDefault();
				const barRect = barEl.getBoundingClientRect();
				const barWidth = barRect.width || 1;
				const clickX = e.clientX - barRect.left; // always relative to bar, not child elements
				const EDGE = Math.min(10, barWidth * 0.3); // edge threshold px
				let type: DragState['type'];
				if (clickX <= EDGE) {
					type = 'resize-start';
				} else if (clickX >= barWidth - EDGE) {
					type = 'resize-end';
				} else {
					type = 'move';
				}
				this._startDrag(type, barEl, entry.file.path, startPropKey, endPropKey,
					dates!.start, dates!.end, e.clientX, min, total);
			});
		}
	}

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
		this._dragState = {
			type, barEl, entryPath, startPropKey, endPropKey,
			origStart: this._localMidnight(origStart),
			origEnd:   this._localMidnight(origEnd),
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

		this._refreshTooltip(newStart, newEnd);
		if (this._dragTooltipEl) {
			this._dragTooltipEl.style.left = `${e.clientX + 14}px`;
			this._dragTooltipEl.style.top  = `${e.clientY - 32}px`;
		}
	}

	private async _onDragEnd(_e: MouseEvent): Promise<void> {
		if (!this._dragState) return;
		const s = this._dragState;
		this._dragState = null;

		s.barEl.removeClass('is-dragging');
		document.body.style.cursor = '';
		(document.body.style as CSSStyleDeclaration & { userSelect: string }).userSelect = '';
		this._dragTooltipEl?.remove();
		this._dragTooltipEl = null;

		// Compute final dates from bar's current style
		const leftPct  = parseFloat(s.barEl.style.left)  || 0;
		const widthPct = parseFloat(s.barEl.style.width) || 0;

		const newStartMs = s.rangeMin.getTime() + (leftPct / 100) * s.totalMs;
		const newStart = new Date(newStartMs); newStart.setHours(0, 0, 0, 0);

		let newEnd: Date;
		if (s.type === 'move') {
			const origDurMs = s.origEnd.getTime() - s.origStart.getTime();
			newEnd = new Date(newStart.getTime() + origDurMs); newEnd.setHours(0, 0, 0, 0);
		} else {
			// bar width includes the +1 day exclusive end; subtract to get inclusive end
			const endExclMs = s.rangeMin.getTime() + ((leftPct + widthPct) / 100) * s.totalMs;
			newEnd = new Date(endExclMs - 86400000); newEnd.setHours(0, 0, 0, 0);
		}

		const file = this.app.vault.getFileByPath(s.entryPath);
		if (!file) return;
		try {
			await this.app.fileManager.processFrontMatter(file, fm => {
				fm[s.startPropKey] = this._fmtDate(newStart);
				fm[s.endPropKey]   = this._fmtDate(newEnd);
			});
		} catch (err) {
			console.error('[Timeline] Failed to update frontmatter:', err);
		}
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

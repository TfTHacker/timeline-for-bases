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

interface ContextSegment {
	start: Date;
	end: Date;
	label: string;
}

interface EntryRenderMeta {
	label: string;
	dates: { start: Date; end: Date; isPoint: boolean } | null;
	color: string | null;
}

const LABEL_COLUMN_WIDTH_PX = 175;
const LABEL_COLUMN_MIN_PX = 80;
const LABEL_COLUMN_MAX_PX = 500;
const PROPERTY_SCAN_ENTRY_LIMIT = 2000;

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

export class TimelineView extends BasesView {
	type = 'timeline';
	containerEl: HTMLElement;
	headerEl: HTMLElement;
	bodyEl: HTMLElement;
	controlsEl: HTMLElement;
	plugin: TimelinePlugin;

	private onResizeDebounce = debounce(() => this.render(), 100, true);

	constructor(controller: QueryController, scrollEl: HTMLElement, plugin: TimelinePlugin) {
		super(controller);
		this.plugin = plugin;
		this.containerEl = scrollEl.createDiv({ cls: 'bases-timeline-view' });
		this.headerEl = this.containerEl.createDiv({ cls: 'bases-timeline-header' });
		this.bodyEl = this.containerEl.createDiv({ cls: 'bases-timeline-body' });
		this.controlsEl = this.containerEl.createDiv({ cls: 'bases-timeline-controls' });
	}

	onload(): void {
		this.render();
	}

	onunload(): void {
		this.containerEl.empty();
	}

	onResize(): void {
		this.onResizeDebounce();
	}

	onDataUpdated(): void {
		this.render();
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

		const entries = this.getVisibleEntries();
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

		if (this.shouldDeferPropertyScan(entries.length)) {
			this.controlsEl.createDiv({
				cls: 'bases-timeline-controls-empty',
				text: `Add a Bases filter before loading color values. This view currently has ${entries.length.toLocaleString()} entries.`,
			});
			return;
		}

		// Color pickers for each unique value
		const uniqueValues = this.getUniqueColorValues(entries, config.colorProp);
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
		const entries = this.getVisibleEntries();

		if (!config.startDateProp || !config.endDateProp) {
			this.bodyEl.createDiv({ cls: 'bases-timeline-empty', text: 'Select start and end date fields in view options.' });
			return;
		}

		if (this.shouldDeferPropertyScan(entries.length)) {
			this.bodyEl.createDiv({
				cls: 'bases-timeline-empty',
				text: `Add a Bases filter before loading start and end dates. This view currently has ${entries.length.toLocaleString()} entries.`,
			});
			return;
		}

		const { entryMeta, timelineRange } = this.buildEntryRenderMeta(entries, config);
		if (!timelineRange) {
			this.bodyEl.createDiv({ cls: 'bases-timeline-empty', text: 'No tasks match the current filtered view.' });
			return;
		}

		// Single scroller — sticky label column, no split pane, no JS scroll sync needed
		const scrollerEl = this.bodyEl.createDiv({ cls: 'bases-timeline-scroller' });
		const canvasEl = scrollerEl.createDiv({ cls: 'bases-timeline-canvas' });

		const scaleZoom = this.getScaleZoomFactor(config.timeScale);
		const zoom = Math.max(config.zoom, 1);
		if (config.timeScale === 'day') {
			const dayTicks = this.getTicksForScale(timelineRange.min, timelineRange.max, 'day', config.weekStart);
			const timelinePx = Math.max(900, dayTicks.length * 44 * zoom);
			canvasEl.style.width = `${config.labelColWidth + timelinePx}px`;
		} else if (config.timeScale === 'week') {
			const weekTicks = this.getTicksForScale(timelineRange.min, timelineRange.max, 'week', config.weekStart);
			const timelinePx = Math.max(900, weekTicks.length * 60 * zoom);
			canvasEl.style.width = `${config.labelColWidth + timelinePx}px`;
		} else if (config.timeScale === 'month') {
			const monthTicks = this.getTicksForScale(timelineRange.min, timelineRange.max, 'month', config.weekStart);
			const timelinePx = Math.max(900, monthTicks.length * 55 * zoom);
			canvasEl.style.width = `${config.labelColWidth + timelinePx}px`;
		} else {
			canvasEl.style.width = `calc(${config.labelColWidth}px + ${zoom * scaleZoom * 100}%)`;
		}

		const ticks = this.getTicksForScale(timelineRange.min, timelineRange.max, config.timeScale, config.weekStart);
		this.renderTimeAxis(canvasEl, timelineRange.min, timelineRange.max, config, ticks);
		this.renderGridLines(canvasEl, ticks, timelineRange.min, timelineRange.max, config.timeScale, config.weekStart, config.labelColWidth);
		if (config.timeScale === 'day') {
			this.renderTodayMarker(canvasEl, timelineRange.min, timelineRange.max, false, config.labelColWidth);
		}

		this.attachRowClickHandler(canvasEl);
		for (const group of groups) {
			this.renderGroup(canvasEl, group, config, timelineRange.min, timelineRange.max, entryMeta);
		}
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

	private renderTimeAxis(containerEl: HTMLElement, min: Date, max: Date, config: TimelineConfig, ticks: Date[]): void {
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

		const visibleTicks = this.reduceTicks(ticks, config.timeScale);
		const formatter = this.getAxisFormatter(min, max, config.timeScale);

		if (config.timeScale === 'day') {
			this.renderDayLabels(labelsEl, ticks, min, max, config.weekStart);
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

	private renderContextHeader(containerEl: HTMLElement, min: Date, max: Date, scale: string): void {
		const headerEl = containerEl.createDiv({ cls: 'bases-timeline-context-header', attr: { 'data-scale': scale } });
		const segments = this.getContextSegments(min, max, scale);
		this.renderContextSegments(headerEl, segments, min, max);
	}

	private getContextSegments(min: Date, max: Date, scale: string): ContextSegment[] {
		if (scale === 'week') {
			return this.buildContextSegments(
				min,
				max,
				date => {
					const current = new Date(date);
					current.setDate(1);
					return current;
				},
				date => {
					const next = new Date(date);
					next.setMonth(next.getMonth() + 1, 1);
					return next;
				},
				date => new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(date),
			);
		}

		if (scale === 'month' || scale === 'quarter') {
			return this.buildContextSegments(
				min,
				max,
				date => {
					const current = new Date(date);
					current.setMonth(0, 1);
					return current;
				},
				date => {
					const next = new Date(date);
					next.setFullYear(next.getFullYear() + 1, 0, 1);
					return next;
				},
				date => date.getFullYear().toString(),
			);
		}

		if (scale === 'year') {
			return this.buildContextSegments(
				min,
				max,
				date => {
					const current = new Date(date);
					const decade = Math.floor(current.getFullYear() / 10) * 10;
					current.setFullYear(decade, 0, 1);
					return current;
				},
				date => {
					const next = new Date(date);
					next.setFullYear(next.getFullYear() + 10, 0, 1);
					return next;
				},
				date => `${date.getFullYear()}–${date.getFullYear() + 9}`,
			);
		}

		return [];
	}

	private buildContextSegments(
		min: Date,
		max: Date,
		alignStart: (date: Date) => Date,
		getNext: (date: Date) => Date,
		getLabel: (date: Date) => string,
	): ContextSegment[] {
		const segments: ContextSegment[] = [];
		let current = alignStart(min);

		while (current <= max) {
			const next = getNext(current);
			segments.push({
				start: new Date(current),
				end: next,
				label: getLabel(current),
			});
			current = next;
		}

		return segments;
	}

	private renderContextSegments(headerEl: HTMLElement, segments: ContextSegment[], min: Date, max: Date): void {
		const total = max.getTime() - min.getTime();

		for (const segment of segments) {
			const offset = Math.max(0, segment.start.getTime() - min.getTime());
			const endOffset = Math.min(total, segment.end.getTime() - min.getTime());
			const width = total === 0 ? 0 : ((endOffset - offset) / total) * 100;
			const left = total === 0 ? 0 : (offset / total) * 100;

			if (width <= 0 || left >= 100) continue;

			const segmentEl = headerEl.createDiv({ cls: 'bases-timeline-context-segment', text: segment.label });
			segmentEl.style.left = `${left}%`;
			segmentEl.style.width = `${width}%`;
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

	private getCompactWeekdayLabel(date: Date, weekStart: 'monday' | 'sunday'): string {
		const mondayLabels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
		const sundayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
		const labels = weekStart === 'sunday' ? sundayLabels : mondayLabels;
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
		// day, week, month: never reduce — always show every tick
		if (scale === 'day' || scale === 'week' || scale === 'month') return ticks;
		const maxVisible = scale === 'year' ? 10 : 16;
		if (ticks.length <= maxVisible) return ticks;
		const step = Math.ceil(ticks.length / maxVisible);
		return ticks.filter((_, i) => i % step === 0 || i === ticks.length - 1);
	}

	private renderGroup(
		containerEl: HTMLElement,
		group: BasesEntryGroup,
		config: TimelineConfig,
		min: Date,
		max: Date,
		entryMeta: Map<BasesEntry, EntryRenderMeta>,
	): void {
		const isGrouped = this.data.groupedData.length > 1 || group.hasKey();
		if (isGrouped) {
			const groupLabel = this.getGroupLabel(group);
			containerEl.createDiv({ cls: 'bases-timeline-group', text: groupLabel });
		}

		group.entries.forEach((entry, index) => {
			this.renderRow(containerEl, entry, config, min, max, index % 2 === 0, entryMeta);
		});
	}

	private renderRow(
		containerEl: HTMLElement,
		entry: BasesEntry,
		config: TimelineConfig,
		min: Date,
		max: Date,
		isEven: boolean = false,
		entryMeta?: Map<BasesEntry, EntryRenderMeta>,
	): void {
		const rowEl = containerEl.createDiv({ cls: 'bases-timeline-row' });
		this.populateRow(rowEl, entry, config, min, max, isEven, entryMeta);
	}

	private populateRow(
		rowEl: HTMLElement,
		entry: BasesEntry,
		config: TimelineConfig,
		min: Date,
		max: Date,
		isEven: boolean = false,
		entryMeta?: Map<BasesEntry, EntryRenderMeta>,
	): void {
		if (isEven) rowEl.addClass('is-even');

		const meta = entryMeta?.get(entry);
		const label = meta?.label ?? this.getEntryLabel(entry, config.labelProp);
		const labelEl = rowEl.createDiv({ cls: 'bases-timeline-label' });
		labelEl.createEl('span', { text: label });

		const trackEl = rowEl.createDiv({ cls: 'bases-timeline-track' });
		rowEl.setAttribute('data-entry-path', entry.file.path);

		const dates = meta?.dates ?? this.getEntryDates(entry, config.startDateProp, config.endDateProp);
		if (!dates) {
			rowEl.addClass('is-missing');
			labelEl.addClass('is-missing');
			return;
		}

		const total = max.getTime() - min.getTime();
		const startOffset = dates.start.getTime() - min.getTime();
		const oneDayMs = 1000 * 60 * 60 * 24;
		const duration = Math.max(0, dates.end.getTime() - dates.start.getTime());
		const effectiveDuration = dates.isPoint ? 0 : duration + oneDayMs;

		const left = total === 0 ? 0 : (startOffset / total) * 100;
		const width = total === 0 ? 100 : Math.max((effectiveDuration / total) * 100, 0.5);

		const barEl = trackEl.createDiv({ cls: 'bases-timeline-bar' });
		if (dates.isPoint) {
			barEl.addClass('is-point');
		} else if (width < 0.8) {
			barEl.addClass('is-compressed');
		}
		barEl.style.left = `${left}%`;
		barEl.style.width = `${width}%`;

		const color = meta?.color ?? this.getEntryColor(entry, config.colorProp, config.colorMap);
		if (color) {
			barEl.style.backgroundColor = color;
		}

		const debugTitle = `${label}\n${entry.file.path}\nstart=${dates.start.toISOString().slice(0, 10)} end=${dates.end.toISOString().slice(0, 10)} point=${dates.isPoint ? 'yes' : 'no'}`;
		barEl.setAttribute('title', debugTitle);
		labelEl.setAttribute('title', debugTitle);
		rowEl.setAttribute('title', debugTitle);
	}

	private getGroupLabel(group: BasesEntryGroup): string {
		return group.key && !Value.equals(group.key, NullValue.value)
			? group.key.toString()
			: 'Ungrouped';
	}

	private attachRowClickHandler(containerEl: HTMLElement): void {
		containerEl.addEventListener('click', (evt: MouseEvent) => {
			const target = evt.target as HTMLElement | null;
			if (!target) return;
			const hit = target.closest('.bases-timeline-label, .bases-timeline-bar');
			if (!hit) return;
			const row = hit.closest('.bases-timeline-row');
			if (!row) return;
			const path = row.getAttribute('data-entry-path');
			if (!path) return;
			evt.preventDefault();
			void this.app.workspace.openLinkText(path, '', evt.ctrlKey || evt.metaKey);
		});
	}

	private getEntryLabel(entry: BasesEntry, labelProp: BasesPropertyId | null): string {
		if (labelProp) {
			const cached = this.getFrontmatterValue(entry, labelProp);
			if (cached != null && cached !== '') return String(cached);
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

	private getFrontmatterValue(entry: BasesEntry, prop: BasesPropertyId | null): unknown | null {
		if (!prop) return null;
		const propId = String(prop);
		if (!propId.startsWith('note.')) return null;
		const cache = this.app.metadataCache.getFileCache(entry.file);
		if (!cache || !cache.frontmatter) return null;
		const key = this.getPropertyName(prop);
		if (!(key in cache.frontmatter)) return null;
		return cache.frontmatter[key];
	}

	private parseDateFromFrontmatter(value: unknown): Date | null {
		if (value instanceof Date) {
			return new Date(value.getTime());
		}
		if (typeof value === 'number') {
			const parsed = new Date(value);
			return Number.isNaN(parsed.getTime()) ? null : parsed;
		}
		if (typeof value === 'string') {
			const parsed = Date.parse(value);
			if (!Number.isNaN(parsed)) return new Date(parsed);
			const dateValue = DateValue.parseFromString(value);
			if (dateValue) {
				const parsedDate = Date.parse(dateValue.toString());
				return Number.isNaN(parsedDate) ? null : new Date(parsedDate);
			}
		}
		return null;
	}

	private buildEntryRenderMeta(
		entries: BasesEntry[],
		config: TimelineConfig,
	): { entryMeta: Map<BasesEntry, EntryRenderMeta>; timelineRange: { min: Date; max: Date } | null } {
		const entryMeta = new Map<BasesEntry, EntryRenderMeta>();
		const dateCache = new Map<Value, Date | null>();
		const startProp = config.startDateProp;
		const endProp = config.endDateProp;
		const labelProp = config.labelProp;
		const colorProp = config.colorProp;

		let min: Date | null = null;
		let max: Date | null = null;

		for (const entry of entries) {
			const label = this.getEntryLabel(entry, labelProp);
			const dates = this.getEntryDatesCached(entry, startProp, endProp, dateCache);
			const color = this.getEntryColor(entry, colorProp, config.colorMap);
			entryMeta.set(entry, { label, dates, color });

			if (dates) {
				if (!min || dates.start < min) min = dates.start;
				if (!max || dates.end > max) max = dates.end;
			}
		}

		if (!min || !max) return { entryMeta, timelineRange: null };

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

		return { entryMeta, timelineRange: { min, max } };
	}

	private getEntryDatesCached(
		entry: BasesEntry,
		startProp: BasesPropertyId | null,
		endProp: BasesPropertyId | null,
		dateCache: Map<Value, Date | null>,
	): { start: Date; end: Date; isPoint: boolean } | null {
		if (!startProp || !endProp) return null;

		let start: Date | null = null;
		let end: Date | null = null;

		const cachedStartRaw = this.getFrontmatterValue(entry, startProp);
		if (cachedStartRaw != null) {
			start = this.parseDateFromFrontmatter(cachedStartRaw);
		}

		const cachedEndRaw = this.getFrontmatterValue(entry, endProp);
		let hasEndValue = cachedEndRaw != null;
		if (cachedEndRaw != null) {
			end = this.parseDateFromFrontmatter(cachedEndRaw);
		}

		if (!start) {
			const startValue = entry.getValue(startProp);
			start = this.parseDateValueCached(startValue, dateCache);
		}

		if (cachedEndRaw == null || (hasEndValue && !end)) {
			const endValue = entry.getValue(endProp);
			hasEndValue = Boolean(endValue && endValue.isTruthy());
			end = this.parseDateValueCached(endValue, dateCache);
		}

		if (!start) return null;
		if (hasEndValue && !end) {
			// End date exists but is invalid/unparseable: do not force point rendering.
			return null;
		}

		const isPoint = !hasEndValue;
		if (!end) end = new Date(start.getTime());
		if (start.getTime() > end.getTime()) return null;

		return { start, end, isPoint };
	}

	private parseDateValueCached(value: Value | null, dateCache: Map<Value, Date | null>): Date | null {
		if (!value || !value.isTruthy()) return null;
		if (dateCache.has(value)) return dateCache.get(value) ?? null;
		const parsed = this.parseDateValue(value);
		dateCache.set(value, parsed);
		return parsed;
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

	private getVisibleEntries(): BasesEntry[] {
		return (this.data.groupedData || []).flatMap(group => group.entries);
	}

	private shouldDeferPropertyScan(entryCount: number): boolean {
		return entryCount > PROPERTY_SCAN_ENTRY_LIMIT;
	}

	private getUniqueColorValues(entries: BasesEntry[], colorProp: BasesPropertyId): string[] {
		const values = new Set<string>();
		for (const entry of entries) {
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
		const cached = this.getFrontmatterValue(entry, colorProp);
		if (cached != null && cached !== '') {
			const key = String(cached);
			return colorMap[key] || null;
		}
		const value = entry.getValue(colorProp);
		if (!value || !value.isTruthy()) return null;
		const key = value.toString();
		return colorMap[key] || null;
	}
}

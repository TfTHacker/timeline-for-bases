import {
	BasesEntry,
	BasesAllOptions,
	BasesEntryGroup,
	BasesPropertyId,
	BasesPropertyOption,
	BasesSortConfig,
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
import {
	addCalendarDays,
	diffCalendarDays,
	formatCalendarDate,
	localMidnight,
	parseCalendarDateString as parseStrictCalendarDateString,
	parseRawFrontmatterDate as parseStrictRawFrontmatterDate,
} from './timeline-date';
import {
	resolveMovedRange,
	resolveResizeEndRange,
	resolveResizeStartRange,
} from './timeline-drag';
import {
	ALL_CUSTOM_KEYS,
	decodeStyleMap,
	encodeStyleMap,
	getClampedBorderWidth,
	getCompleteStyleMap,
} from './timeline-style-config';
import { applyCustomKeysToYaml } from './timeline-base-yaml';
import {
	formatTickLabel,
	getAxisFormatter,
	getMinorGridTicks,
	getTicksForScale,
	reduceTicks,
	snapEndToScale,
	snapStartToScale,
} from './timeline-axis';
import { getTimelineCanvasWidth } from './timeline-canvas';

interface TimelineConfig {
	startDateProp: BasesPropertyId | null;
	endDateProp: BasesPropertyId | null;
	primaryProp: BasesPropertyId | null;
	orderedProps: BasesPropertyId[];
	colorProp: BasesPropertyId | null;
	colorMap: Record<string, string>;
	borderProp: BasesPropertyId | null;
	borderColorMap: Record<string, string>;
	borderWidth: number;
	zoom: number;
	timeScale: 'day' | 'week' | 'month' | 'quarter' | 'year';
	weekStart: 'monday' | 'sunday';
	labelColWidth: number;
	/** Raw frontmatter key used for groupBy, if any. Null when not grouped. */
	groupByProp: string | null;
	/** Whether the start/end date properties are writable frontmatter fields (not formulas or file metadata). */
	startWritable: boolean;
	endWritable: boolean;
	/** Whether the groupBy property is a writable frontmatter field (e.g. note.status). False for file.* or formula properties. */
	groupWritable: boolean;
	/** Ordered list of extra properties to display as columns. */
	extraProps: BasesPropertyId[];
	/** Width (px) for each extra prop column, keyed by JSON.stringify(propId). */
	propColWidths: Record<string, number>;
	/** Total width of the frozen left zone (label col + all prop cols). */
	frozenWidth: number;
	/** Persisted collapsed state keyed by group property + label. */
	collapsedGroups: Record<string, boolean>;
}

interface RenderGroup {
	label: string;
	entries: BasesEntry[];
	hasKey: boolean;
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

const MAX_COLOR_VALUES = 10;

interface StyleConfigSpec {
	sectionTitle: string;
	sectionRole: 'fill' | 'border';
	propKey: 'colorBy' | 'borderBy';
	mapKey: 'colorMap' | 'borderColorMap';
	selectedProp: BasesPropertyId | null;
	selectedMap: Record<string, string>;
	applyToBars: (value: string, color: string) => void;
}

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
	dayStepPx: number | null;
	mouseAnchorDate: Date | null;
	mouseAnchorOffsetDays: number;
	barStartPx: number;
	barEndPx: number;
	rangeMin: Date;         // local midnight (= timeline min)
	totalMs: number;        // max - min in ms
	// Updated each mousemove — used directly in mouseup to avoid CSS precision loss
	pendingStart: Date;
	pendingEnd: Date;
}

interface DayLabelSlot {
	date: Date;
	left: number;
	right: number;
	width: number;
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
	private _activeDrawEndListener: ((e: MouseEvent) => void) | null = null;
	private _draggedColumnKey: string | null = null;
	private _suppressHeaderClick = false;
	private _groupDragPreviewEl: HTMLElement | null = null;
	private _todayVisibilityEls: HTMLElement[] = [];
	private _scrollSyncRaf = 0;
	private _todaySyncRaf = 0;
	private _viewConfigOverrides: Record<string, unknown> = {};
	private _dayLabelSlots: DayLabelSlot[] = [];
	private _rowElsByPath = new Map<string, HTMLElement>();
	private _barElsByPath = new Map<string, HTMLElement>();

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
		if (this._activeDrawEndListener) window.removeEventListener('mouseup', this._activeDrawEndListener, true);
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
		this.resetRenderCaches();
		this.headerEl.empty();
		this.bodyEl.empty();
		this.controlsEl.empty();

		if (!this.data) return;

		const config = this.loadConfig();
		this.applyGroupedLayoutInset(config, this.getRenderGroups(config));
		this.containerEl.setAttribute('data-density', 'compact');
		this.containerEl.style.setProperty('--timeline-label-col-width', `${config.labelColWidth}px`);
		this.containerEl.style.setProperty('--timeline-frozen-width', `${config.frozenWidth}px`);
		this.containerEl.style.setProperty('--tl-bar-border-width', `${config.borderWidth}px`);

		this.renderHeader(config);
		this.renderControls(config);
		this.renderTimeline(config);
	}

	private loadConfig(): TimelineConfig {
		const startDateProp = this.config.getAsPropertyId('startDate');
		const endDateProp = this.config.getAsPropertyId('endDate');
		// colorBy / borderBy aren't declared Bases options, so config.getAsPropertyId()
		// won't find them after a save/reload cycle. Read them from overrides first,
		// then from raw YAML view data, then from Bases config as fallback.
		const colorProp = this.getPropertyIdFromConfig('colorBy');
		const borderProp = this.getPropertyIdFromConfig('borderBy');
		const rawConfig = this.getRawConfig();
		const colorMap = this.getStyleMapFromConfig('colorMap');
		const borderColorMap = this.getStyleMapFromConfig('borderColorMap');
		const borderWidth = getClampedBorderWidth(
			this.getViewConfigValue('borderWidth'),
			borderProp ? 2 : 1,
		);
		const zoom = this.getNumericConfig('zoom', 1, 1, 5);
		const timeScale = this.getStringConfig('timeScale', 'week', ['day', 'week', 'month', 'quarter', 'year']) as 'day' | 'week' | 'month' | 'quarter' | 'year';
		const weekStart = this.plugin.settings.defaultWeekStart;
		const labelColWidth = this.getNumericConfig('labelColWidth', LABEL_COLUMN_WIDTH_PX, LABEL_COLUMN_MIN_PX, LABEL_COLUMN_MAX_PX);

		// Read the groupBy property name from the raw Bases config
		const rawGroupBy = rawConfig.groupBy as { property?: string } | undefined;
		const groupByProp: string | null = rawGroupBy?.property ?? null;

		// A property is writable only if it references a frontmatter field (note.*)
		// Formula and file properties are computed/read-only.
		const isWritable = (prop: BasesPropertyId | null): boolean =>
			prop !== null && String(prop).startsWith('note.');
		const startWritable = isWritable(startDateProp);
		const endWritable   = isWritable(endDateProp);
		const groupWritable = isWritable(groupByProp as BasesPropertyId | null);

		// The first ordered property becomes the primary frozen column.
		const orderedProps = this.config.getOrder();
		const primaryProp = orderedProps[0] ?? null;
		const extraProps = orderedProps.slice(1);

		// Per-prop column widths (persisted in .base file as encoded string)
		const rawWidths = this.getViewConfigValue('propColWidths');
		const savedWidthsRaw = (typeof rawWidths === 'string' ? decodeStyleMap(rawWidths) : rawWidths ?? {});
		const rawCollapsed = this.getViewConfigValue('collapsedGroups');
		const collapsedGroupsRaw = (typeof rawCollapsed === 'string' ? decodeStyleMap(rawCollapsed) : rawCollapsed ?? {});
		// DecodeMap returns string values; parse numbers/booleans for type-safe access
		const savedWidths: Record<string, number> = {};
		for (const [k, v] of Object.entries(savedWidthsRaw)) {
			const num = Number(v);
			if (!isNaN(num)) savedWidths[k] = num;
		}
		const collapsedGroups: Record<string, boolean> = {};
		for (const [k, v] of Object.entries(collapsedGroupsRaw)) {
			collapsedGroups[k] = v === 'true' || v === true;
		}
		const propColWidths: Record<string, number> = {};
		let frozenWidth = labelColWidth;
		extraProps.forEach((prop) => {
			const key = JSON.stringify(prop);
			// encodeMap strips JSON quotes from keys for clean YAML storage,
			// so savedWidths uses plain keys like "note.priority" while
			// JSON.stringify produces '"note.priority"'. Check both forms.
			const plainKey = String(prop);
			const w = (key in savedWidths) ? savedWidths[key]
				: (plainKey in savedWidths) ? savedWidths[plainKey]
				: PROP_COLUMN_WIDTH_PX;
			propColWidths[key] = w;
			frozenWidth += w;
		});

		return {
			startDateProp,
			endDateProp,
			primaryProp,
			orderedProps,
			colorProp,
			colorMap,
			borderProp,
			borderColorMap,
			borderWidth,
			zoom,
			timeScale,
			weekStart,
			labelColWidth,
			groupByProp,
			startWritable,
			endWritable,
			groupWritable,
			extraProps,
			propColWidths,
			frozenWidth,
			collapsedGroups,
		};
	}

	private getRawConfig(): Record<string, unknown> {
		return this.config as unknown as Record<string, unknown>;
	}

	private getSavedViewConfig(): Record<string, unknown> {
		const baseProto = Object.getPrototypeOf(TimelineView.prototype) as { getViewConfig?: () => unknown };
		return (baseProto.getViewConfig?.call(this) ?? {}) as Record<string, unknown>;
	}

	getViewConfig(): Record<string, unknown> {
		return {
			...this.getSavedViewConfig(),
			...this._viewConfigOverrides,
		};
	}

	/** Find the Bases leaf that owns this TimelineView.
	 *  Iterates all bases leaves and returns the one whose view's
	 *  DOM subtree contains this.containerEl — avoiding the bug of
	 *  always grabbing the first leaf when multiple are open. */
	private _getHostBasesLeaf(): import('obsidian').WorkspaceLeaf | undefined {
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
			const viewEl = (leaf.view as { containerEl?: HTMLElement })?.containerEl;
			if (viewEl && viewEl.contains(this.containerEl)) return leaf;
		}
		// Fallback: if DOM check fails (e.g. not yet mounted), use first leaf
		return this.app.workspace.getLeavesOfType('bases')[0];
	}

	private getViewConfigValue(key: string): unknown {
		if (key in this._viewConfigOverrides) return this._viewConfigOverrides[key];
		const saved = this.getSavedViewConfig();
		if (key in saved) return saved[key];
		return this.config.get(key);
	}

	private setViewConfigValue<T>(key: string, value: T, persistOnly = false): void {
		this._viewConfigOverrides[key] = value as unknown;
		this.getRawConfig()[key] = value as unknown;

		const hostView = this._getHostBasesLeaf()?.view as
			| { getViewData?: () => string; setViewData?: (data: string, clear: boolean) => void; requestSave?: () => Promise<void> | void }
			| undefined;

		if (persistOnly) {
			// For persist-only saves, skip config.set() and requestSave() / setViewData()
			// entirely — config.set() may trigger Bases' auto-save which recreates the view.
			// Instead write the custom keys directly to the .base file via vault.modify().
			// The caller is responsible for any needed re-render.
			void this._persistCustomKeysDirect(hostView);
		} else {
			this.config.set(key, value);
			const requestSave = hostView?.requestSave;
			if (typeof requestSave === 'function') {
				void Promise.resolve(requestSave.call(hostView)).then(() => {
					this._persistCustomKeys(hostView);
				});
			}
		}
	}

	/** Collect overrides for custom keys in the current session. */
	private _collectCustomOverrides(): Record<string, unknown> {
		const overrides: Record<string, unknown> = {};
		for (const key of ALL_CUSTOM_KEYS) {
			if (key in this._viewConfigOverrides) overrides[key] = this._viewConfigOverrides[key];
		}
		return overrides;
	}

	/** Write custom keys directly to the .base file without triggering a
	 *  Bases save cycle (which would recreate the view, causing a white flash).
	 *  Reads the current file content, injects/updates custom keys in YAML,
	 *  and writes back via vault.modify(). */
	private async _persistCustomKeysDirect(hostView: { getViewData?: () => string } | undefined): Promise<void> {
		const leaf = this._getHostBasesLeaf();
		const file = (leaf?.view as { file?: { path?: string } } | undefined)?.file;
		if (!file?.path) return;

		const getViewData = hostView?.getViewData;
		if (typeof getViewData !== 'function') return;

		const { yaml, changed } = applyCustomKeysToYaml(
			getViewData.call(hostView),
			this._collectCustomOverrides(),
		);
		if (!changed) return;

		const abstractFile = this.app.vault.getAbstractFileByPath(file.path);
		if (!abstractFile) return;
		await this.app.vault.modify(abstractFile as any, yaml);
	}

	/** After Bases saves its declared options, inject session overrides and
	 *  re-quote any CUSTOM_STRING_KEYS that Bases' serializer wrote unquoted.
	 *  Writes via setViewData + requestSave so Bases' save pipeline owns the
	 *  final round-trip. */
	private _persistCustomKeys(hostView: { getViewData?: () => string; setViewData?: (data: string, clear: boolean) => void; requestSave?: () => Promise<void> | void } | undefined): void {
		const getViewData = hostView?.getViewData;
		const setViewData = hostView?.setViewData;
		if (typeof getViewData !== 'function' || typeof setViewData !== 'function') return;

		const { yaml, changed } = applyCustomKeysToYaml(
			getViewData.call(hostView),
			this._collectCustomOverrides(),
		);
		if (!changed) return;

		setViewData.call(hostView, yaml, true);
		const requestSave = hostView?.requestSave;
		if (typeof requestSave === 'function') {
			void Promise.resolve(requestSave.call(hostView));
		}
	}

	// String-encoding for object maps persisted in .base files uses `=` / `;`
	// as separators because `:` and `|` are YAML-special; see timeline-style-config.

	private getStyleMapFromConfig(key: string): Record<string, string> {
		const raw = this.getViewConfigValue(key);
		if (typeof raw === 'string') return decodeStyleMap(raw);
		// Legacy: in-memory object from current session before reload
		if (raw && typeof raw === 'object') return { ...(raw as Record<string, string>) };
		return {};
	}

	private getControlsVisible(): boolean {
		const value = this.getViewConfigValue('showColors');
		if (typeof value === 'boolean') return value;
		if (value === 'false' || value === false) return false;
		if (value === 'true' || value === true) return true;
		return true; // default open
	}

	private resetRenderCaches(): void {
		this._todayVisibilityEls = [];
		this._dayLabelSlots = [];
		this._rowElsByPath.clear();
		this._barElsByPath.clear();
		if (this._scrollSyncRaf) cancelAnimationFrame(this._scrollSyncRaf);
		if (this._todaySyncRaf) cancelAnimationFrame(this._todaySyncRaf);
		this._scrollSyncRaf = 0;
		this._todaySyncRaf = 0;
	}

	private bindActiveDrawEnd(): void {
		if (this._activeDrawEndListener) window.removeEventListener('mouseup', this._activeDrawEndListener, true);
		this._activeDrawEndListener = (e: MouseEvent) => {
			void this._onDragEnd(e);
		};
		window.addEventListener('mouseup', this._activeDrawEndListener, { capture: true, once: true });
	}

	private clearActiveDrawEndBinding(): void {
		if (!this._activeDrawEndListener) return;
		window.removeEventListener('mouseup', this._activeDrawEndListener, true);
		this._activeDrawEndListener = null;
	}

	private applyGroupedLayoutInset(config: TimelineConfig, groups: RenderGroup[]): void {
		const hasGroupedTimeline = groups.length > 1 || groups.some(group => group.hasKey);
		if (!hasGroupedTimeline || config.extraProps.length === 0) return;
		const lastProp = config.extraProps[config.extraProps.length - 1];
		const key = JSON.stringify(lastProp);
		const current = config.propColWidths[key] ?? PROP_COLUMN_WIDTH_PX;
		const next = current + 24;
		config.propColWidths[key] = next;
		config.frozenWidth += next - current;
	}

	private getNumericConfig(key: string, defaultValue: number, min?: number, max?: number): number {
		const value = this.getViewConfigValue(key);
		if (value == null) return defaultValue;
		// Coerce strings to numbers (Bases YAML parser may return numeric values as strings)
		const numValue = typeof value === 'number' ? value : Number(value);
		if (isNaN(numValue)) return defaultValue;

		let result = numValue;
		if (min !== undefined) result = Math.max(min, result);
		if (max !== undefined) result = Math.min(max, result);
		return result;
	}

	private getStringConfig(key: string, defaultValue: string, allowedValues?: string[]): string {
		const value = this.getViewConfigValue(key);
		if (value == null) return defaultValue;
		const strValue = typeof value === 'string' ? value : String(value);
		if (allowedValues && !allowedValues.includes(strValue)) return defaultValue;
		return strValue;
	}

	/** Read a BasesPropertyId from multiple sources: in-memory overrides,
	 *  the raw YAML view data (parse the key from getViewData()), or
	 *  Bases' declared config.  Needed for keys like `colorBy` that
	 *  aren't declared Bases options and get stripped by `requestSave()`. */
	private getPropertyIdFromConfig(key: string): BasesPropertyId | null {
		// 1) Override set in the current session — includes explicit null (clear)
		if (key in this._viewConfigOverrides) {
			const override = this._viewConfigOverrides[key];
			if (override == null) return null;
			// BasesPropertyId is a string like "file.fullname" or "note.priority"
			// but may be stored as a parsed object from JSON.parse; coerce to string
			if (typeof override === 'string') return override as BasesPropertyId;
			// Object form: BasesPropertyId has a toString() returning canonical form
			const str = String(override);
			return (str !== '[object Object]' ? str : null) as BasesPropertyId | null;
		}
		// 2) Parse from the host view's YAML data
		const hostView = this._getHostBasesLeaf()?.view as
			| { getViewData?: () => string }
			| undefined;
		const getViewData = hostView?.getViewData;
		if (typeof getViewData === 'function') {
			const yaml = getViewData.call(hostView);
			const pattern = new RegExp(`^    ${key}:\\s(.+)$`, 'm');
			const match = pattern.exec(yaml);
			if (match) {
				const value = match[1].trim().replace(/^['"]|['"]$/g, '');
				if (value) return value as BasesPropertyId;
			}
		}
		// 3) Bases declared config fallback
		return this.config.getAsPropertyId(key);
	}

	private renderHeader(config: TimelineConfig): void {
		const groups = this.getRenderGroups(config);
		const hasGroupedTimeline = groups.length > 1 || groups.some(group => group.hasKey);

		// Left side: view controls
		const leftEl = this.headerEl.createDiv({ cls: 'bases-timeline-header-left' });

		// Time scale selector
		const scaleEl = leftEl.createDiv({ cls: 'bases-timeline-scale-selector' });
		scaleEl.createDiv({ cls: 'bases-timeline-scale-label', text: 'Scale:' });
		const scaleButtons = scaleEl.createDiv({ cls: 'bases-timeline-scale-buttons' });
		(['day', 'week', 'month', 'quarter', 'year'] as const).forEach(scale => {
			const btn = scaleButtons.createEl('button', { cls: 'bases-timeline-scale-btn', text: scale.charAt(0).toUpperCase() + scale.slice(1) });
			if (config.timeScale === scale) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				this.setViewConfigValue('timeScale', scale, true);
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

		if (hasGroupedTimeline) {
			const groupActionsEl = leftEl.createDiv({ cls: 'bases-timeline-group-actions' });
			const collapseAllBtn = groupActionsEl.createEl('button', { cls: 'bases-timeline-nav-btn is-icon-only', attr: { 'aria-label': 'Collapse all groups', title: 'Collapse all groups' } });
			setIcon(collapseAllBtn, 'fold-vertical');
			collapseAllBtn.addEventListener('click', () => this.setAllGroupsCollapsed(config, groups, true));
			const expandAllBtn = groupActionsEl.createEl('button', { cls: 'bases-timeline-nav-btn is-icon-only', attr: { 'aria-label': 'Expand all groups', title: 'Expand all groups' } });
			setIcon(expandAllBtn, 'unfold-vertical');
			expandAllBtn.addEventListener('click', () => this.setAllGroupsCollapsed(config, groups, false));
		}

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
			this.setViewConfigValue('showColors', next, true);
			this.render();
		});
	}

	private renderControls(config: TimelineConfig): void {
		const isVisible = this.getControlsVisible();
		this.controlsEl.toggleClass('is-collapsed', !isVisible);
		if (!isVisible) return;

		this.renderStyleControls(config, {
			sectionTitle: 'Color by',
			sectionRole: 'fill',
			propKey: 'colorBy',
			mapKey: 'colorMap',
			selectedProp: config.colorProp,
			selectedMap: config.colorMap,
			applyToBars: (value, color) => this.applyFillColorToBars(value, color),
		});

		this.renderStyleControls(config, {
			sectionTitle: 'Border by',
			sectionRole: 'border',
			propKey: 'borderBy',
			mapKey: 'borderColorMap',
			selectedProp: config.borderProp,
			selectedMap: config.borderColorMap,
			applyToBars: (value, color) => this.applyBorderColorToBars(value, color),
		});
	}

	private renderStyleControls(config: TimelineConfig, spec: StyleConfigSpec): void {
		const allProps = [...(this.allProperties ?? [])].sort((a, b) =>
			this.getPropertyName(a).localeCompare(this.getPropertyName(b))
		);

		const sectionEl = this.controlsEl.createDiv({ cls: 'bases-timeline-style-section' });
		sectionEl.setAttribute('data-style-role', spec.sectionRole);

		const propRowEl = sectionEl.createDiv({ cls: 'bases-timeline-config-row' });
		propRowEl.createSpan({ cls: 'bases-timeline-config-label', text: `${spec.sectionTitle}:` });

		const propSelect = propRowEl.createEl('select', { cls: 'bases-timeline-config-select' });
		propSelect.createEl('option', { value: '', text: '— none —' });
		allProps.forEach(prop => {
			const name = this.getPropertyName(prop);
			const opt = propSelect.createEl('option', { value: JSON.stringify(prop), text: name });
			if (spec.selectedProp && JSON.stringify(spec.selectedProp) === JSON.stringify(prop)) {
				opt.selected = true;
			}
		});

		if (spec.sectionRole === 'border') {
			this.renderBorderWidthControl(propRowEl, config);
		}

		propSelect.addEventListener('change', () => {
			const val = propSelect.value;
			if (!val) {
				this.setViewConfigValue(spec.propKey, null, true);
			} else {
				try {
					this.setViewConfigValue(spec.propKey, JSON.parse(val), true);
				} catch {
					return;
				}
			}
			this.render();
		});

		if (!spec.selectedProp) return;

		const allUniqueValues = this.getUniqueStyleValues(spec.selectedProp);
		const { styleMap, changed } = getCompleteStyleMap(spec.selectedMap, allUniqueValues, PALETTE);
		if (changed) {
			this.setViewConfigValue(spec.mapKey, encodeStyleMap(styleMap), true);
			spec.selectedMap = styleMap;
		}

		if (allUniqueValues.length === 0) {
			sectionEl.createDiv({ cls: 'bases-timeline-controls-empty', text: 'No values found for the selected property.' });
			return;
		}

		const uniqueValues = allUniqueValues.slice(0, MAX_COLOR_VALUES);
		let openPalette: HTMLElement | null = null;
		const listEl = sectionEl.createDiv({ cls: 'bases-timeline-color-list' });

		uniqueValues.forEach(value => {
			const itemEl = listEl.createDiv({ cls: 'bases-timeline-color-item' });
			itemEl.createDiv({ cls: 'bases-timeline-color-label', text: value });

			const currentColor = spec.selectedMap[value] || PALETTE[0];
			const dot = itemEl.createDiv({ cls: 'bases-timeline-swatch is-current' });
			dot.style.background = currentColor;
			dot.setAttribute('aria-label', `Pick ${spec.sectionTitle.toLowerCase()} color`);

			const paletteEl = itemEl.createDiv({ cls: 'bases-timeline-swatch-popup is-hidden' });
			PALETTE.forEach(color => {
				const swatch = paletteEl.createDiv({ cls: 'bases-timeline-swatch' });
				swatch.style.background = color;
				if (currentColor === color) swatch.addClass('is-selected');
				swatch.addEventListener('click', (e) => {
					e.stopPropagation();
					spec.selectedMap[value] = color;
					this.setViewConfigValue(spec.mapKey, encodeStyleMap(spec.selectedMap), true);
					spec.applyToBars(value, color);
					paletteEl.querySelectorAll('.bases-timeline-swatch').forEach(s => s.removeClass('is-selected'));
					swatch.addClass('is-selected');
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

		if (allUniqueValues.length > MAX_COLOR_VALUES) {
			sectionEl.createDiv({
				cls: 'bases-timeline-color-cap-warning',
				text: `Showing ${MAX_COLOR_VALUES} of ${allUniqueValues.length} values. Choose a property with fewer unique values for individual colors.`,
			});
		}
	}

	private renderBorderWidthControl(rowEl: HTMLElement, config: TimelineConfig): void {
		rowEl.createSpan({ cls: 'bases-timeline-config-label bases-timeline-config-label--inline', text: 'Border width:' });
		const selectEl = rowEl.createEl('select', { cls: 'bases-timeline-config-select bases-timeline-config-select--inline' });
		[1, 2, 3, 4].forEach(width => {
			const opt = selectEl.createEl('option', { value: String(width), text: `${width}px` });
			if (config.borderWidth === width) opt.selected = true;
		});
		selectEl.addEventListener('change', () => {
			const next = getClampedBorderWidth(selectEl.value, config.borderWidth);
			this.setViewConfigValue('borderWidth', next, true);
			this.render();
		});
	}

	private getPropertyName(prop: BasesPropertyId): string {
		const str = String(prop);
		// BasesPropertyId format: "note.propname" | "file.something" | "formula.name"
		const dotIdx = str.indexOf('.');
		return dotIdx >= 0 ? str.slice(dotIdx + 1) : str;
	}

	private getRenderGroups(config: TimelineConfig): RenderGroup[] {
		const hostGroups = (this.data as { groupedData?: BasesEntryGroup[] } | undefined)?.groupedData;
		if (hostGroups && hostGroups.length > 0) {
			return hostGroups.map(group => ({
				label: (group.key && !Value.equals(group.key, NullValue.value)) ? group.key.toString() : 'Ungrouped',
				entries: group.entries,
				hasKey: group.hasKey(),
			}));
		}

		const source = (this.data as { data?: BasesEntry[] } | BasesEntry[] | undefined);
		const entries = Array.isArray(source)
			? source
			: Array.isArray((source as { data?: BasesEntry[] } | undefined)?.data)
				? (source as { data: BasesEntry[] }).data
				: [];
		if (!config.groupByProp) return [{ label: 'Ungrouped', entries, hasKey: false }];

		const propId = String(config.groupByProp).startsWith('note.')
			? String(config.groupByProp)
			: `note.${config.groupByProp}`;
		const groups = new Map<string, BasesEntry[]>();
		for (const entry of entries) {
			let label = '';
			const value = entry.getValue(propId as BasesPropertyId);
			if (value && value.isTruthy()) label = value.toString();
			if (!label) {
				const fm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter;
				const raw = fm?.[String(config.groupByProp).replace(/^note\./, '')];
				label = raw == null || raw === '' ? '' : String(raw);
			}
			const key = label || 'Ungrouped';
			const bucket = groups.get(key);
			if (bucket) bucket.push(entry);
			else groups.set(key, [entry]);
		}

		return Array.from(groups.entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([label, groupedEntries]) => ({
				label,
				entries: groupedEntries,
				hasKey: label !== 'Ungrouped',
			}));
	}

	private renderTimeline(config: TimelineConfig): void {
		const groups = this.getRenderGroups(config);
		this.containerEl.style.setProperty('--timeline-group-gutter', '0px');

		if (!config.startDateProp || !config.endDateProp) {
			this.bodyEl.createDiv({ cls: 'bases-timeline-empty', text: 'Select start and end date fields in view options.' });
			return;
		}

		// --- Step 1: Determine render window ---
		const rangeStartMs = this.getViewConfigValue('rangeStartDate');
		const rangePresetDays = this.getViewConfigValue('rangePresetDays');
		const hasFixedWindow = typeof rangeStartMs === 'number' && rangeStartMs > 0
			&& typeof rangePresetDays === 'number' && rangePresetDays > 0;

		this._lastConfig = config;

		if (hasFixedWindow) {
			// Fixed window: canvas can be set up immediately (min/max known from config).
			// All entry processing + row rendering is deferred async to keep the UI responsive.
			const min = new Date(rangeStartMs as number);
			min.setHours(0, 0, 0, 0);
			// rangePresetDays is inclusive: a 7-day preset spans days 0..6, so the
			// window ends at (rangePresetDays - 1) days after min, at end-of-day.
			const max = addCalendarDays(min, (rangePresetDays as number) - 1);
			max.setHours(23, 59, 59, 999);
			this._rangeMin = min; this._rangeMax = max;

			// Render canvas structure synchronously — visible immediately
			const scrollerEl = this.bodyEl.createDiv({ cls: 'bases-timeline-scroller' });
			this._scrollerEl = scrollerEl;
			this.bindScrollOverlaySync(scrollerEl);
			const canvasEl = scrollerEl.createDiv({ cls: 'bases-timeline-canvas' });
			const ticks = getTicksForScale(min, max, config.timeScale, config.weekStart);
			canvasEl.style.width = getTimelineCanvasWidth({
				frozenWidth: config.frozenWidth,
				tickCount: ticks.length,
				timeScale: config.timeScale,
				zoom: config.zoom,
			});
			this.renderTimeAxis(canvasEl, min, max, config, ticks);
			this.cacheDayLabelGeometry(canvasEl);
			this.renderGridLines(canvasEl, ticks, min, max, config.timeScale, config.weekStart, config.frozenWidth);
			this.renderTodayMarker(canvasEl, min, max, true, config.frozenWidth);
			this.bindTodayMarkerVisibilitySync(scrollerEl, config.frozenWidth);
			this.attachRowClickHandler(canvasEl);

			// Defer all entry work async — yields to browser between chunks
			const seq = ++this._renderSeq;
			const startPropName = String(config.startDateProp).startsWith('note.')
				? this.getPropertyName(config.startDateProp!) : null;
			const endPropName = config.endDateProp && String(config.endDateProp).startsWith('note.')
				? this.getPropertyName(config.endDateProp) : null;
			const entryDatesCache = new Map<BasesEntry, { start: Date; end: Date; isPoint: boolean; isInvalid?: boolean } | null>();
			const CHUNK = 50;

			(async () => {
				let rowIndex = 0;
				for (const group of groups) {
					if (this._renderSeq !== seq) return;

					const isGrouped = groups.length > 1 || group.hasKey;
					const groupLabel = group.label;
					const isCollapsed = this.isGroupCollapsed(groupLabel, config);
					if (isGrouped) {
						this.renderGroupHeading(canvasEl, group, config, isCollapsed);
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

						this.renderRow(canvasEl, entry, config, min, max, rowIndex % 2 === 0, entryDatesCache);
						rowIndex++;
					}

					this.applyCollapsedStateToRenderedGroups(config.collapsedGroups, config.groupByProp);
				}

				this.applyCollapsedStateToRenderedGroups(config.collapsedGroups, config.groupByProp);
			})();

		} else {
			// Auto-fit: compute range from all entries synchronously (small dataset path)
			const entries = groups.flatMap(g => g.entries);
			const entryDatesCache = new Map<BasesEntry, { start: Date; end: Date; isPoint: boolean; isInvalid?: boolean } | null>();
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
			let min = snapStartToScale(minDate, config.timeScale, config.weekStart);
			let max = snapEndToScale(maxDate, config.timeScale, config.weekStart);
			const dayMs = 24 * 60 * 60 * 1000;
			const weekMs = 7 * dayMs;
			if (config.timeScale === 'day') {
				// Ensure at least 10 days are visible by padding max if needed
				const minDays = 10;
				const spanDays = Math.round((max.getTime() - min.getTime()) / dayMs);
				if (spanDays < minDays) {
					max = new Date(min.getTime() + minDays * dayMs);
					max.setHours(23, 59, 59, 999);
				}
			} else if (config.timeScale === 'week') {
				min = new Date(min.getTime() - weekMs);
				max = new Date(max.getTime() + 2 * weekMs);
			} else if (config.timeScale === 'quarter') {
				// Ensure at least 4 quarters visible
				const spanMs = max.getTime() - min.getTime();
				const quarterMs = 3 * 30.5 * dayMs;
				if (spanMs < 4 * quarterMs) {
					max = new Date(min.getTime() + 4 * quarterMs);
					max = snapEndToScale(max, 'quarter');
				}
			} else if (config.timeScale === 'year') {
				// Ensure at least 3 years visible
				const spanMs = max.getTime() - min.getTime();
				const yearMs = 365 * dayMs;
				if (spanMs < 3 * yearMs) {
					max = new Date(min.getTime() + 3 * yearMs);
					max = snapEndToScale(max, 'year');
				}
			} else {
				max = new Date(max.getTime() + weekMs);
			}

			this._rangeMin = min; this._rangeMax = max;
			const scrollerEl = this.bodyEl.createDiv({ cls: 'bases-timeline-scroller' });
			this._scrollerEl = scrollerEl;
			this.bindScrollOverlaySync(scrollerEl);
			const canvasEl = scrollerEl.createDiv({ cls: 'bases-timeline-canvas' });
			const ticks = getTicksForScale(min, max, config.timeScale, config.weekStart);
			canvasEl.style.width = getTimelineCanvasWidth({
				frozenWidth: config.frozenWidth,
				tickCount: ticks.length,
				timeScale: config.timeScale,
				zoom: config.zoom,
			});
			this.renderTimeAxis(canvasEl, min, max, config, ticks);
			this.cacheDayLabelGeometry(canvasEl);
			this.renderGridLines(canvasEl, ticks, min, max, config.timeScale, config.weekStart, config.frozenWidth);
			this.renderTodayMarker(canvasEl, min, max, true, config.frozenWidth);
			this.bindTodayMarkerVisibilitySync(scrollerEl, config.frozenWidth);
			this.attachRowClickHandler(canvasEl);

			for (const group of groups) {
				this.renderGroup(canvasEl, group, config, min, max, entryDatesCache, groups.length);
			}

			this.applyCollapsedStateToRenderedGroups(config.collapsedGroups, config.groupByProp);
		}
	}

	private bindScrollOverlaySync(scrollerEl: HTMLElement): void {
		const sync = () => {
			if (this._scrollSyncRaf) cancelAnimationFrame(this._scrollSyncRaf);
			this._scrollSyncRaf = requestAnimationFrame(() => {
				this._scrollSyncRaf = 0;
				this.syncOverlayClip(scrollerEl);
			});
		};
		scrollerEl.addEventListener('scroll', sync, { passive: true });
		sync();
	}

	private syncOverlayClip(scrollerEl: HTMLElement): void {
		const scrollLeft = `${scrollerEl.scrollLeft}px`;
		this.containerEl.style.setProperty('--timeline-scroll-left', scrollLeft);
	}

	private bindTodayMarkerVisibilitySync(scrollerEl: HTMLElement, frozenWidth: number): void {
		const sync = () => {
			if (this._todaySyncRaf) cancelAnimationFrame(this._todaySyncRaf);
			this._todaySyncRaf = requestAnimationFrame(() => {
				this._todaySyncRaf = 0;
				const scrollerRect = scrollerEl.getBoundingClientRect();
				const visibleTimelineLeft = scrollerRect.left + frozenWidth;
				const visibleTimelineRight = scrollerRect.right;
				this._todayVisibilityEls.forEach(el => {
					const rect = el.getBoundingClientRect();
					const isVisible = rect.right > visibleTimelineLeft && rect.left < visibleTimelineRight;
					el.style.visibility = isVisible ? 'visible' : 'hidden';
				});
			});
		};
		scrollerEl.addEventListener('scroll', sync, { passive: true });
		sync();
	}

	/** Resolve entry dates using metadata cache (fast path). Falls back to Bases API if cache is incomplete. */
	private resolveEntryDatesFromCache(
		entry: BasesEntry,
		startPropName: string | null,
		endPropName: string | null,
		_min: Date,
		max: Date,
		config: TimelineConfig
	): { start: Date; end: Date; isPoint: boolean; isInvalid?: boolean } | null {
		const fmCache = this.app.metadataCache.getFileCache(entry.file)?.frontmatter;
		if (fmCache) {
			const startRaw = startPropName ? fmCache[startPropName] : undefined;
			const endRaw   = endPropName   ? fmCache[endPropName]   : undefined;
			const hasStart = startRaw != null && startRaw !== '' && startRaw !== false;
			const hasEnd   = endRaw   != null && endRaw   !== '' && endRaw   !== false;

			if (!hasStart && !hasEnd) return null;

			const start = hasStart ? this.parseRawFrontmatterDate(startRaw) : null;
			const end   = hasEnd   ? this.parseRawFrontmatterDate(endRaw)   : null;

			// End-only: use end as a 1-day bar
			if (!hasStart && end) {
				return { start: end, end: new Date(end.getTime()), isPoint: true };
			}

			if (!start) return this.getEntryDates(entry, config.startDateProp!, config.endDateProp!);
			if (start > max) return null;

			if (!hasEnd || !end) {
				return { start, end: new Date(start.getTime()), isPoint: true };
			}

			// Start after end: flag invalid, swap for rendering
			if (start.getTime() > end.getTime()) {
				return { start: end, end: start, isPoint: false, isInvalid: true };
			}

			return { start, end, isPoint: false };
		}
		// Fall back to authoritative Bases API
		return this.getEntryDates(entry, config.startDateProp!, config.endDateProp!);
	}
	private renderTodayMarker(containerEl: HTMLElement, min: Date, max: Date, showLabel: boolean, frozenWidth = LABEL_COLUMN_WIDTH_PX): void {
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		if (today < min || today > max) return;

		const total = max.getTime() - min.getTime();
		const offset = today.getTime() - min.getTime();
		const left = total === 0 ? 0 : (offset / total) * 100;

		// Anchor the today overlay to the full frozen zone so it never renders under sticky prop columns.
		const markerTrackEl = containerEl.createDiv({ cls: 'bases-timeline-overlay-track' });
		markerTrackEl.style.left = `${frozenWidth}px`;
		markerTrackEl.style.width = `calc(100% - ${frozenWidth}px)`;

		if (showLabel) {
			const labelEl = markerTrackEl.createDiv({ cls: 'bases-timeline-today-label', text: 'Today' });
			labelEl.style.left = `${left}%`;
			labelEl.setAttribute('title', today.toLocaleDateString());
			this._todayVisibilityEls.push(labelEl);
		}

		const markerEl = markerTrackEl.createDiv({ cls: 'bases-timeline-today-marker' });
		markerEl.style.left = `${left}%`;
		markerEl.setAttribute('title', `Today: ${today.toLocaleDateString()}`);
		this._todayVisibilityEls.push(markerEl);
	}

	private cacheDayLabelGeometry(containerEl: HTMLElement): void {
		const containerRect = containerEl.getBoundingClientRect();
		const labels = Array.from(containerEl.querySelectorAll<HTMLElement>('.bases-timeline-axis-label.is-day-label'));
		this._dayLabelSlots = labels.map((label) => {
			const raw = label.getAttribute('data-date');
			const date = raw ? this.parseRawFrontmatterDate(raw) : null;
			const rect = label.getBoundingClientRect();
			const left = rect.left - containerRect.left;
			const width = rect.width;
			return date && width > 0 ? {
				date,
				left,
				right: left + width,
				width,
			} : null;
		}).filter((slot): slot is DayLabelSlot => slot !== null);
	}

	private renderTimeAxis(containerEl: HTMLElement, min: Date, max: Date, config: TimelineConfig, ticks?: Date[]): void {
		const axisEl = containerEl.createDiv({ cls: 'bases-timeline-axis' });
		axisEl.setAttribute('data-scale', config.timeScale);

		// Sticky frozen-left header: primary property + one header per remaining property col
		const spacerEl = axisEl.createDiv({ cls: 'bases-timeline-axis-spacer' });
		const primaryHeaderEl = spacerEl.createDiv({
			cls: 'bases-timeline-notes-header',
		});
		this.setupColumnHeader(primaryHeaderEl, config.primaryProp, true);
		this.attachResizeHandle(primaryHeaderEl, config);
		for (const prop of config.extraProps) {
			const key = JSON.stringify(prop);
			const w = config.propColWidths[key] ?? PROP_COLUMN_WIDTH_PX;
			const headerCell = spacerEl.createDiv({
				cls: 'bases-timeline-prop-col-header',
			});
			headerCell.style.width = `${w}px`;
			headerCell.style.minWidth = `${w}px`;
			this.setupColumnHeader(headerCell, prop, false);
			this.attachPropColResizeHandle(headerCell, prop, config);
		}

		const timelineAxisEl = axisEl.createDiv({ cls: 'bases-timeline-axis-inner' });

		// All scales get a context header row — day uses 'week' context path (renders month spans)
		const contextScale = config.timeScale === 'day' ? 'week' : config.timeScale;
		this.renderContextHeader(timelineAxisEl, min, max, contextScale);

		const labelsEl = timelineAxisEl.createDiv({ cls: 'bases-timeline-axis-labels' });
		labelsEl.setAttribute('data-scale', config.timeScale);
		labelsEl.addClass('has-context');

		const resolvedTicks = ticks ?? getTicksForScale(min, max, config.timeScale, config.weekStart);
		const visibleTicks = reduceTicks(resolvedTicks, config.timeScale);
		const formatter = getAxisFormatter(min, max, config.timeScale);

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
				const label = formatTickLabel(date, config.timeScale, formatter);
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

	private renderDayLabels(labelsEl: HTMLElement, dayTicks: Date[], min: Date, max: Date, weekStart: 'monday' | 'sunday'): void {
		labelsEl.addClass('is-day-scale');
		const total = max.getTime() - min.getTime();
		const oneDayMs = 1000 * 60 * 60 * 24;
		const axisWidthPx = labelsEl.getBoundingClientRect().width || labelsEl.parentElement?.getBoundingClientRect().width || 0;

		for (let i = 0; i < dayTicks.length; i++) {
			const date = dayTicks[i];
			const startMs = Math.max(min.getTime(), date.getTime());
			const nextTick = dayTicks[i + 1];
			const endMs = Math.min(max.getTime(), nextTick ? nextTick.getTime() : date.getTime() + oneDayMs);
			if (endMs <= startMs) continue;

			const leftRatio = total === 0 ? 0 : (startMs - min.getTime()) / total;
			const widthRatio = total === 0 ? 1 : (endMs - startMs) / total;
			if (leftRatio < -0.01 || leftRatio > 1.01) continue;

			const slotWidthPx = axisWidthPx > 0 ? widthRatio * axisWidthPx : 0;
			const dayEl = labelsEl.createDiv({ cls: 'bases-timeline-axis-label is-day-label' });
			dayEl.style.left = `${leftRatio * 100}%`;
			dayEl.style.width = `${Math.max(0, widthRatio * 100)}%`;
			dayEl.setAttribute('title', date.toLocaleDateString());
			dayEl.setAttribute('data-date', formatCalendarDate(date));
			this.populateAdaptiveDayLabel(dayEl, date, weekStart, slotWidthPx);
		}
	}

	private getCompactWeekdayLabel(date: Date, _weekStart: 'monday' | 'sunday'): string {
		// getDay(): 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
		const labels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
		return labels[date.getDay()] ?? new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date).slice(0, 2);
	}

	private populateAdaptiveDayLabel(dayEl: HTMLElement, date: Date, weekStart: 'monday' | 'sunday', slotWidthPx: number): void {
		const weekday = this.getCompactWeekdayLabel(date, weekStart);
		if (slotWidthPx >= 28) {
			dayEl.addClass('is-stacked');
			dayEl.createSpan({ cls: 'bases-timeline-day-weekday', text: weekday });
			dayEl.createSpan({ cls: 'bases-timeline-day-date', text: String(date.getDate()) });
			return;
		}
		if (slotWidthPx >= 18) {
			dayEl.createSpan({ cls: 'bases-timeline-day-weekday', text: weekday });
			return;
		}
		if (slotWidthPx >= 12) {
			dayEl.createSpan({ cls: 'bases-timeline-day-weekday', text: weekday.charAt(0) });
		}
	}

	private attachResizeHandle(labelEl: HTMLElement, config: TimelineConfig): void {
		const handle = labelEl.createDiv({ cls: 'bases-timeline-resize-handle' });
		handle.setAttribute('draggable', 'false');
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
			this.setViewConfigValue('labelColWidth', newWidth, true);
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
		handle.setAttribute('draggable', 'false');
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
			const raw = this.getViewConfigValue('propColWidths');
			const saved = (typeof raw === 'string' ? decodeStyleMap(raw) : raw ?? {}) as Record<string, string>;
			saved[key] = String(newWidth);
			this.setViewConfigValue('propColWidths', encodeStyleMap(saved), true);
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

	private setupColumnHeader(headerEl: HTMLElement, prop: BasesPropertyId | null, isPrimary: boolean): void {
		headerEl.empty();
		headerEl.addClass('bases-timeline-column-header');
		if (isPrimary) headerEl.addClass('is-primary');

		const iconName = this.getHeaderIcon(prop);
		if (iconName) {
			const iconEl = headerEl.createSpan({ cls: 'bases-timeline-column-header-icon' });
			iconEl.setAttribute('draggable', 'false');
			setIcon(iconEl, iconName);
		}

		const labelEl = headerEl.createSpan({
			cls: 'bases-timeline-column-header-label',
			text: prop ? this.config.getDisplayName(prop) : 'Name',
		});
		labelEl.setAttribute('draggable', 'false');

		const sortDirection = this.getSortDirection(prop);
		if (sortDirection) {
			headerEl.addClass(sortDirection === 'ASC' ? 'is-sort-asc' : 'is-sort-desc');
			headerEl.setAttribute('data-sort', sortDirection);
			const sortEl = headerEl.createSpan({ cls: 'bases-timeline-column-sort-indicator' });
			sortEl.setAttribute('draggable', 'false');
			setIcon(sortEl, sortDirection === 'ASC' ? 'chevron-up' : 'chevron-down');
		} else {
			headerEl.removeAttribute('data-sort');
		}

		if (!prop) return;

		const propKey = JSON.stringify(prop);
		headerEl.setAttribute('draggable', 'true');
		headerEl.setAttribute('data-prop-key', propKey);
		headerEl.setAttribute('title', `${this.config.getDisplayName(prop)}. Click to add or cycle sort, drag to reorder.`);

		headerEl.addEventListener('dragstart', (e: DragEvent) => {
			if ((e.target as HTMLElement | null)?.closest('.bases-timeline-resize-handle')) {
				e.preventDefault();
				return;
			}
			this._draggedColumnKey = propKey;
			this._suppressHeaderClick = false;
			e.dataTransfer?.setData('text/plain', propKey);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
			headerEl.addClass('is-dragging');
		});

		headerEl.addEventListener('dragend', () => {
			this._draggedColumnKey = null;
			this._suppressHeaderClick = true;
			headerEl.removeClass('is-dragging');
			this.containerEl.querySelectorAll('.bases-timeline-column-header.is-drop-target').forEach(el => el.removeClass('is-drop-target'));
			window.setTimeout(() => { this._suppressHeaderClick = false; }, 0);
		});

		headerEl.addEventListener('dragover', (e: DragEvent) => {
			if (!this._draggedColumnKey || this._draggedColumnKey === propKey) return;
			e.preventDefault();
			headerEl.addClass('is-drop-target');
		});

		headerEl.addEventListener('dragleave', () => headerEl.removeClass('is-drop-target'));

		headerEl.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			headerEl.removeClass('is-drop-target');
			const fromKey = this._draggedColumnKey ?? e.dataTransfer?.getData('text/plain');
			if (!fromKey || fromKey === propKey) return;
			this.reorderColumns(fromKey, propKey);
		});

		headerEl.addEventListener('click', (e: MouseEvent) => {
			if ((e.target as HTMLElement | null)?.closest('.bases-timeline-resize-handle')) return;
			if (this._suppressHeaderClick) return;
			this.toggleSort(prop);
		});
	}

	private getHeaderIcon(prop: BasesPropertyId | null): string | null {
		if (!prop) return 'info';

		const propId = String(prop);
		if (propId.startsWith('file.')) {
			if (propId === 'file.name' || propId === 'file.basename') return 'info';
			if (propId === 'file.folder') return 'folder-open';
			if (propId === 'file.tags') return 'tags';
			if (propId === 'file.ctime' || propId === 'file.mtime') return 'clock-3';
			return 'info';
		}

		const propKey = propId.replace(/^note\./, '');
		const propType = this._getPropType(propKey);
		if (propType === 'date' || propType === 'datetime') return 'calendar';
		if (propType === 'number') return 'binary';
		if (propType === 'checkbox') return 'check-square';
		if (propType === 'multitext') return 'list';
		if (propType === 'tags') return 'tags';

		return 'text';
	}

	private reorderColumns(fromKey: string, toKey: string): void {
		const ordered = [...this.config.getOrder()];
		const fromIndex = ordered.findIndex(prop => JSON.stringify(prop) === fromKey);
		const toIndex = ordered.findIndex(prop => JSON.stringify(prop) === toKey);
		if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

		const [moved] = ordered.splice(fromIndex, 1);
		ordered.splice(toIndex, 0, moved);
			this.setViewConfigValue('order', ordered);
			this.render();
		}

	private getSortDirection(prop: BasesPropertyId | null): 'ASC' | 'DESC' | null {
		if (!prop) return null;
		const sortEntry = this.config.getSort().find(sort => JSON.stringify(sort.property) === JSON.stringify(prop));
		return sortEntry?.direction ?? null;
	}

	private toggleSort(prop: BasesPropertyId): void {
		const current = this.getSortDirection(prop);
		const existing = [...this.config.getSort()];
		const existingIndex = existing.findIndex(sort => JSON.stringify(sort.property) === JSON.stringify(prop));
		let nextSort: BasesSortConfig[] = [...existing];

		if (!current) {
			nextSort = [...existing, { property: prop, direction: 'ASC' }];
		} else if (current === 'ASC') {
			nextSort = [...existing];
			nextSort[existingIndex] = { property: prop, direction: 'DESC' };
		} else {
			nextSort = existing.filter((_, index) => index !== existingIndex);
		}

		this.setViewConfigValue('sort', nextSort);
		this.render();
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
				const labelEl = isLabel as HTMLElement;
				const clickMode = labelEl.getAttribute('data-click-mode');
				if (clickMode === 'edit') return;
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

	private startInlinePropCellEdit(
		valueSpan: HTMLElement,
		editBtn: HTMLButtonElement | null,
		entry: BasesEntry,
		propKey: string,
		propType: string,
		text: string,
	): void {
		editBtn?.hide();
		const input = document.createElement('input');
		input.type = propType === 'number' ? 'number' : 'text';
		input.value = valueSpan.textContent || '';
		input.className = 'bases-timeline-prop-cell-input';
		valueSpan.replaceWith(input);
		input.focus(); input.select();
		input.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
		input.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation());

		let dropdown: HTMLElement | null = null;
		const removeDropdown = () => { dropdown?.remove(); dropdown = null; };

		if (propType !== 'number') {
			const allValues = this.plugin.getCachedVaultValuesForProp(propKey);
			const showDropdown = (filter: string, showAll = false) => {
				removeDropdown();
				const lower = filter.toLowerCase();
				const matches = allValues.filter(v => showAll ? true : v.toLowerCase().includes(lower));
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
			setTimeout(() => showDropdown(input.value, true), 0);
		}

		const save = async () => {
			removeDropdown();
			const newVal = input.value.trim();
			input.replaceWith(valueSpan);
			editBtn?.show();
			if (newVal !== text) {
				valueSpan.textContent = newVal;
				const file = this.app.vault.getFileByPath(entry.file.path);
				if (file) {
					await this.app.fileManager.processFrontMatter(file, fm => {
						if (newVal === '') delete fm[propKey];
						else if (propType === 'number') fm[propKey] = parseFloat(newVal);
						else fm[propKey] = newVal;
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
	}

	private startInlineLabelEdit(
		labelSpan: HTMLElement,
		editBtn: HTMLButtonElement | null,
		entry: BasesEntry,
		label: string,
		labelPropKey: string | null,
		isFileNameProp: boolean,
	): void {
		editBtn?.hide();
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
			editBtn?.show();
			if (newVal && newVal !== label) {
				labelSpan.textContent = newVal;
				const file = this.app.vault.getFileByPath(entry.file.path);
				if (file) {
					if (labelPropKey) {
						await this.app.fileManager.processFrontMatter(file, fm => { fm[labelPropKey] = newVal; });
					} else if (isFileNameProp) {
						const dir = file.parent?.path;
						const newPath = normalizePath(dir ? `${dir}/${newVal}.md` : `${newVal}.md`);
						await this.app.fileManager.renameFile(file, newPath);
					}
				}
			}
		};
		input.addEventListener('blur', save);
		input.addEventListener('keydown', (ke: KeyboardEvent) => {
			if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
			if (ke.key === 'Escape') { input.value = label; input.blur(); }
		});
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
			const minorTicks = getMinorGridTicks(min, max, scale, weekStart);
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

	private renderGroup(containerEl: HTMLElement, group: RenderGroup, config: TimelineConfig, min: Date, max: Date, entryDatesCache: Map<BasesEntry, { start: Date; end: Date; isPoint: boolean; isInvalid?: boolean } | null>, groupCount: number): void {
		const isGrouped = groupCount > 1 || group.hasKey;
		const groupLabel = group.label;
		const isCollapsed = this.isGroupCollapsed(groupLabel, config);

		if (isGrouped) {
			const groupHeaderEl = this.renderGroupHeading(containerEl, group, config, isCollapsed);

			// Make the group header a drop target (only for writable group properties)
			if (config.groupWritable) {
				groupHeaderEl.addEventListener('dragover', (e) => {
					e.preventDefault();
					this.containerEl.addClass('is-group-drag-active');
					groupHeaderEl.addClass('is-drag-over');
				});
				groupHeaderEl.addEventListener('dragleave', () => {
					groupHeaderEl.removeClass('is-drag-over');
				});
				groupHeaderEl.addEventListener('drop', (e) => {
					e.preventDefault();
					groupHeaderEl.removeClass('is-drag-over');
					this.clearGroupDragState();
					const raw = e.dataTransfer?.getData('text/plain');
					if (!raw) return;
					try {
						const { path, fromGroup } = JSON.parse(raw) as { path: string; fromGroup: string };
						void this._dropToGroup(path, fromGroup, groupLabel, config.groupByProp);
					} catch { /* ignore malformed drag data */ }
				});
			}
			}

		let rowIndex = 0;
		group.entries.forEach((entry) => {
			const dates = entryDatesCache.get(entry) ?? null;
			if (dates && (dates.end < min || dates.start > max)) return;
			this.renderRow(containerEl, entry, config, min, max, rowIndex % 2 === 0, entryDatesCache, isGrouped ? groupLabel : null);
			rowIndex++;
		});
	}

	private renderGroupHeading(containerEl: HTMLElement, group: RenderGroup, config: TimelineConfig, isCollapsed = false): HTMLElement {
		const groupLabel = group.label;
		const groupProperty = config.groupByProp
			? String(config.groupByProp).replace(/^note\./, '')
			: 'Group';
		const groupHeaderEl = containerEl.createDiv({ cls: 'bases-timeline-group' });
		// Persist collapse identity on the element so recovery does not depend on rendered text.
		groupHeaderEl.setAttribute('data-collapse-key', this.getGroupCollapseKey(groupLabel, config));
		if (isCollapsed) groupHeaderEl.addClass('is-collapsed');
		const headingEl = groupHeaderEl.createDiv({ cls: 'bases-group-heading' });
		const toggleEl = headingEl.createEl('button', {
			cls: 'bases-timeline-group-toggle',
			attr: {
				type: 'button',
				'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'} ${groupLabel} group`,
			},
		});
		setIcon(toggleEl, isCollapsed ? 'chevron-right' : 'chevron-down');
		headingEl.createDiv({ cls: 'bases-group-property', text: groupProperty });
		headingEl.createDiv({ cls: 'bases-group-value', text: groupLabel });
		groupHeaderEl.setAttribute('title', `${isCollapsed ? 'Expand' : 'Collapse'} group`);
		toggleEl.addEventListener('click', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.toggleGroupCollapsed(groupLabel, config);
		});
		groupHeaderEl.addEventListener('click', (e: MouseEvent) => {
			if ((e.target as HTMLElement | null)?.closest('.bases-timeline-drag-handle')) return;
			if ((e.target as HTMLElement | null)?.closest('button, input, a')) return;
			this.toggleGroupCollapsed(groupLabel, config);
		});
		return groupHeaderEl;
	}

	private getGroupCollapseKey(groupLabel: string, config: TimelineConfig): string {
		const groupProp = config.groupByProp ? String(config.groupByProp).replace(/^note\./, '') : '__group__';
		return `${groupProp}::${groupLabel}`;
	}

	private isGroupCollapsed(groupLabel: string, config: TimelineConfig): boolean {
		return !!config.collapsedGroups[this.getGroupCollapseKey(groupLabel, config)];
	}

	private setAllGroupsCollapsed(config: TimelineConfig, groups: RenderGroup[], collapsed: boolean): void {
		const next: Record<string, boolean> = {};
		for (const group of groups) {
			if (!(groups.length > 1 || group.hasKey)) continue;
			const key = this.getGroupCollapseKey(group.label, config);
			if (collapsed) next[key] = true;
		}
		this.setViewConfigValue('collapsedGroups', encodeStyleMap(next as unknown as Record<string, string>), true);
		config.collapsedGroups = next;
		this.applyCollapsedStateToRenderedGroups(next, config.groupByProp);
	}

	private toggleGroupCollapsed(groupLabel: string, config: TimelineConfig): void {
		const next = { ...config.collapsedGroups };
		const key = this.getGroupCollapseKey(groupLabel, config);
		if (next[key]) delete next[key];
		else next[key] = true;
		this.setViewConfigValue('collapsedGroups', encodeStyleMap(next as unknown as Record<string, string>), true);
		config.collapsedGroups = next;
		this.applyCollapsedStateToRenderedGroups(next, config.groupByProp);
	}

	private clearGroupDragState(): void {
		this.containerEl.removeClass('is-group-drag-active');
		this.containerEl.querySelectorAll('.bases-timeline-group.is-drag-over').forEach(el => el.removeClass('is-drag-over'));
		this.containerEl.querySelectorAll('.bases-timeline-row.is-drop-target').forEach(el => el.removeClass('is-drop-target'));
		this.containerEl.querySelectorAll('.bases-timeline-row.is-dragging').forEach(el => el.removeClass('is-dragging'));
		this._groupDragPreviewEl?.remove();
		this._groupDragPreviewEl = null;
	}

	private createGroupDragPreview(label: string): HTMLElement {
		this._groupDragPreviewEl?.remove();
		const previewEl = document.body.createDiv({ cls: 'bases-timeline-drag-preview' });
		const iconEl = previewEl.createSpan({ cls: 'bases-timeline-drag-preview-icon' });
		setIcon(iconEl, 'grip-vertical');
		previewEl.createSpan({ cls: 'bases-timeline-drag-preview-label', text: label });
		this._groupDragPreviewEl = previewEl;
		return previewEl;
	}

	private applyCollapsedStateToRenderedGroups(collapsedGroups: Record<string, boolean>, _groupByProp: string | null): void {
		const groupHeaders = Array.from(this.bodyEl.querySelectorAll('.bases-timeline-group')) as HTMLElement[];
		for (const groupHeaderEl of groupHeaders) {
			// Collapse key is stamped onto the element at render time — decoupled from header text.
			const collapseKey = groupHeaderEl.getAttribute('data-collapse-key');
			if (!collapseKey) continue;
			this.setRenderedGroupCollapsed(groupHeaderEl, !!collapsedGroups[collapseKey]);
		}
	}

	private setRenderedGroupCollapsed(groupHeaderEl: HTMLElement, isCollapsed: boolean): void {
		groupHeaderEl.toggleClass('is-collapsed', isCollapsed);
		groupHeaderEl.setAttribute('title', `${isCollapsed ? 'Expand' : 'Collapse'} group`);
		const toggleEl = groupHeaderEl.querySelector('.bases-timeline-group-toggle');
		if (toggleEl instanceof HTMLElement) {
			setIcon(toggleEl, isCollapsed ? 'chevron-right' : 'chevron-down');
			toggleEl.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} group`);
		}

		let sibling = groupHeaderEl.nextElementSibling as HTMLElement | null;
		while (sibling && !sibling.hasClass('bases-timeline-group')) {
			sibling.toggleClass('is-group-collapsed-hidden', isCollapsed);
			sibling = sibling.nextElementSibling as HTMLElement | null;
		}
	}

	private renderRow(containerEl: HTMLElement, entry: BasesEntry, config: TimelineConfig, min: Date, max: Date, isEven: boolean = false, entryDatesCache: Map<BasesEntry, { start: Date; end: Date; isPoint: boolean; isInvalid?: boolean } | null>, currentGroupLabel: string | null = null): void {
		const rowEl = containerEl.createDiv({ cls: 'bases-timeline-row' });
		if (isEven) rowEl.addClass('is-even');
		rowEl.setAttribute('data-entry-path', entry.file.path);
		this._rowElsByPath.set(entry.file.path, rowEl);

		if (currentGroupLabel !== null && config.groupWritable) {
			// Make the row itself a drop target (any row in another group works)
			rowEl.addEventListener('dragover', (e) => {
				const raw = e.dataTransfer?.types.includes('text/plain');
				if (!raw) return;
				e.preventDefault();
				this.containerEl.addClass('is-group-drag-active');
				rowEl.addClass('is-drop-target');
			});
			rowEl.addEventListener('dragleave', () => rowEl.removeClass('is-drop-target'));
			rowEl.addEventListener('drop', (e) => {
				e.preventDefault();
				rowEl.removeClass('is-drop-target');
				this.clearGroupDragState();
				const data = e.dataTransfer?.getData('text/plain');
				if (!data) return;
				try {
					const { path, fromGroup } = JSON.parse(data) as { path: string; fromGroup: string };
					if (path === entry.file.path) return; // dropped onto itself
					void this._dropToGroup(path, fromGroup, currentGroupLabel!, config.groupByProp);
				} catch { /* ignore */ }
			});
		}

		const label = this.getEntryLabel(entry, config.primaryProp);
		const labelEl = rowEl.createDiv({ cls: 'bases-timeline-label' });
		if (currentGroupLabel !== null && config.groupWritable) {
			labelEl.addClass('has-group-drag-handle');
			const handle = labelEl.createDiv({ cls: 'bases-timeline-drag-handle', attr: { draggable: 'true', title: `Drag to move "${entry.file.basename}" to another group`, 'aria-label': 'Drag to move to another group' } });
			setIcon(handle, 'grip-vertical');
			handle.addEventListener('click', (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
			});
			handle.addEventListener('dragstart', (e) => {
				const payload = JSON.stringify({ path: entry.file.path, fromGroup: currentGroupLabel });
				e.dataTransfer?.setData('text/plain', payload);
				e.dataTransfer!.effectAllowed = 'move';
				this.clearGroupDragState();
				const previewEl = this.createGroupDragPreview(this.getEntryLabel(entry, config.primaryProp));
				e.dataTransfer?.setDragImage(previewEl, 14, Math.round(previewEl.offsetHeight / 2));
				this.containerEl.addClass('is-group-drag-active');
				rowEl.addClass('is-dragging');
			});
			handle.addEventListener('dragend', () => {
				this.clearGroupDragState();
			});
		}
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
		config.extraProps.forEach((prop, propIndex) => {
			const key = JSON.stringify(prop);
			const w = config.propColWidths[key] ?? PROP_COLUMN_WIDTH_PX;
			const val = entry.getValue(prop);
			const text = (val && val.isTruthy()) ? val.toString() : '';
			const propCell = rowEl.createDiv({ cls: 'bases-timeline-prop-cell' });
			if (propIndex === config.extraProps.length - 1) propCell.addClass('is-last-frozen');
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
				propCell.addClass('is-editable');

				if (propType === 'checkbox') {
					// Checkbox: toggle on click
					const isChecked = text === 'true';
					if (isChecked) valueSpan.addClass('is-checked');
					const toggleCheckbox = async (e?: MouseEvent) => {
						e?.stopPropagation(); e?.preventDefault();
						const newVal = !isChecked;
						const file = this.app.vault.getFileByPath(entry.file.path);
						if (file) {
							await this.app.fileManager.processFrontMatter(file, fm => { fm[propKey] = newVal; });
						}
					};
					propCell.addEventListener('click', toggleCheckbox);
				} else if (propType === 'date' || propType === 'datetime') {
					// Match Bases table behavior: render an inline date input in the cell.
					valueSpan.remove();
					const dateCell = propCell.createDiv({
						cls: 'bases-table-cell bases-metadata-value metadata-property-value bases-timeline-date-cell',
					});
					dateCell.setAttribute('data-property-type', 'date');

					const dateInput = dateCell.createEl('input', {
						type: 'date',
						cls: 'metadata-input metadata-input-text mod-date',
						attr: { max: '9999-12-31', placeholder: 'Empty' },
					});
					const parsedDate = this.parseDateValue(val) ?? this.parseRawFrontmatterDate(text);
					dateInput.value = parsedDate ? formatCalendarDate(parsedDate) : '';
					dateInput.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
					dateInput.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation());

					const saveDate = async () => {
						const newVal = dateInput.value.trim();
						const oldVal = parsedDate ? formatCalendarDate(parsedDate) : '';
						if (newVal === oldVal) return;
						const file = this.app.vault.getFileByPath(entry.file.path);
						if (file) {
							await this.app.fileManager.processFrontMatter(file, fm => {
								if (newVal === '') delete fm[propKey];
								else fm[propKey] = newVal;
							});
						}
					};

					dateInput.addEventListener('change', () => { void saveDate(); });
					dateInput.addEventListener('blur', () => { void saveDate(); });
					dateInput.addEventListener('keydown', (ke: KeyboardEvent) => {
						if (ke.key === 'Enter') {
							ke.preventDefault();
							dateInput.blur();
						}
						if (ke.key === 'Escape') {
							dateInput.value = parsedDate ? formatCalendarDate(parsedDate) : '';
							dateInput.blur();
						}
					});
					propCell.addEventListener('click', (e: MouseEvent) => {
						if ((e.target as HTMLElement | null)?.closest('input, button, a')) return;
						e.preventDefault();
						e.stopPropagation();
						dateInput.focus();
						if (typeof dateInput.showPicker === 'function') {
							try {
								dateInput.showPicker();
							} catch {
								// Some environments require a trusted user gesture; focus is still enough to edit.
							}
						}
					});
				} else {
					// Text / number / multitext / tags / anything else: inline input
					const beginEdit = (e?: MouseEvent) => {
						e?.stopPropagation(); e?.preventDefault();
						if (propCell.querySelector('input.bases-timeline-prop-cell-input')) return;
						this.startInlinePropCellEdit(valueSpan, null, entry, propKey, propType, text);
					};
					propCell.addEventListener('click', (e: MouseEvent) => {
						if ((e.target as HTMLElement | null)?.closest('button, input, a')) return;
						beginEdit(e);
					});
				}
			} else {
				// Read-only cell
				propCell.createEl('span', { text, cls: 'bases-timeline-prop-cell-value is-readonly' });
			}
		});



		// Inline edit: pencil icon appears on hover → click to edit
		if (config.extraProps.length === 0) labelEl.addClass('is-last-frozen');
		const primaryPropId = config.primaryProp ? String(config.primaryProp) : null;
		const labelPropKey = primaryPropId?.startsWith('note.') ? primaryPropId.replace(/^note\./, '') : null;
		const isFileNameProp = primaryPropId === 'file.name' || primaryPropId === 'file.basename';
		if (labelPropKey || isFileNameProp) {
			labelEl.setAttribute('data-click-mode', labelPropKey && !isFileNameProp ? 'edit' : 'open');
			const editBtn = isFileNameProp ? labelEl.createEl('button', { cls: 'bases-timeline-label-edit-btn' }) : null;
			if (editBtn) {
				setIcon(editBtn, 'pencil');
				editBtn.setAttribute('aria-label', 'Edit name');
			}
			const beginLabelEdit = (e?: MouseEvent) => {
				e?.stopPropagation(); e?.preventDefault();
				if (labelEl.querySelector('input.bases-timeline-label-input')) return;
				this.startInlineLabelEdit(labelSpan, editBtn, entry, label, labelPropKey, isFileNameProp);
			};
			editBtn?.addEventListener('click', beginLabelEdit);
			if (labelPropKey && !isFileNameProp) {
				labelEl.addClass('is-editable');
				labelEl.addEventListener('click', (e: MouseEvent) => {
					if ((e.target as HTMLElement | null)?.closest('button, input, a, .bases-timeline-drag-handle')) return;
					beginLabelEdit(e);
				});
			}
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
					const anchorDate = localMidnight(new Date(this._rangeMin.getTime() + pct * totalMs));
					const ghostEl  = trackEl.createDiv({ cls: 'bases-timeline-draw-ghost' });
					ghostEl.style.left  = `${pct * 100}%`;
					ghostEl.style.width = '0%';
					this._draw = { entryPath: entry.file.path, startKey, endKey, anchorDate, rangeMin: this._rangeMin!, totalMs, trackEl, ghostEl };
					this.bindActiveDrawEnd();
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

		if (dates.isInvalid) {
			rowEl.addClass('is-date-invalid');
			rowEl.setAttribute('title', 'Warning: start date is after end date');
			return;
		}

		const barEl = trackEl.createDiv({ cls: 'bases-timeline-bar' });
		this._barElsByPath.set(entry.file.path, barEl);
		if (width < 0.8) {
			barEl.addClass('is-compressed');
		}
		barEl.style.left = `${left}%`;
		barEl.style.width = `${width}%`;

		const fillColor = this.getEntryStyleColor(entry, config.colorProp, config.colorMap);
		if (fillColor) {
			barEl.style.backgroundColor = fillColor;
		}
		const borderColor = this.getEntryStyleColor(entry, config.borderProp, config.borderColorMap);
		if (borderColor) {
			barEl.style.borderColor = borderColor;
			barEl.style.setProperty('--tl-bar-border-color', borderColor);
		}
		// Store the color value keys for in-place color updates
		if (config.colorProp) {
			const colorVal = entry.getValue(config.colorProp);
			if (colorVal?.isTruthy()) {
				barEl.setAttribute('data-color-value', colorVal.toString());
			}
		}
		if (config.borderProp) {
			const borderVal = entry.getValue(config.borderProp);
			if (borderVal?.isTruthy()) {
				barEl.setAttribute('data-border-value', borderVal.toString());
			}
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
				if (e.button !== 0) return;
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
				this._cancelActiveDrag();
				this._showContextMenu(e, entry, startPropKey, endPropKey, dates!.start, dates!.end, canEdit, config.startWritable, config.endWritable);
			});
		}
	}

	// ─── Navigation ──────────────────────────────────────────────────────────

	private _scrollToDate(date: Date): void {
		const scroller = this._scrollerEl;
		if (!scroller) return;

		const target = new Date(date);
		target.setHours(0, 0, 0, 0);
		const frozenWidth = this._lastConfig?.frozenWidth ?? 0;
		const visibleTimelineWidth = Math.max(0, scroller.clientWidth - frozenWidth);

		// Prefer the rendered marker position when it exists so navigation survives reload/render timing issues.
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		if (target.getTime() === today.getTime()) {
			const marker = this.bodyEl.querySelector<HTMLElement>('.bases-timeline-today-marker');
			if (marker) {
				const scrollerRect = scroller.getBoundingClientRect();
				const markerRect = marker.getBoundingClientRect();
				const markerCenter = scroller.scrollLeft + (markerRect.left - scrollerRect.left) + markerRect.width / 2;
				const desiredCenter = frozenWidth + visibleTimelineWidth / 2;
				const nextLeft = markerCenter - desiredCenter;
				scroller.scrollTo({ left: Math.max(0, nextLeft), behavior: 'smooth' });
				return;
			}
		}

		const min = this._rangeMin;
		const max = this._rangeMax;
		const config = this._lastConfig;
		if (!min || !max || !config) return;
		const total = max.getTime() - min.getTime();
		if (total === 0) return;

		const ratio = (target.getTime() - min.getTime()) / total;
		const trackWidth = scroller.scrollWidth - config.frozenWidth;
		const scrollLeft = ratio * trackWidth - visibleTimelineWidth / 2;
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

	private _showJumpToDate(anchor: HTMLElement, _evt: MouseEvent): void {
		const existing = document.getElementById('tl-jump-popover');
		if (existing) { existing.remove(); return; }

		const popover = document.body.createDiv({ attr: { id: 'tl-jump-popover' }, cls: 'bases-timeline-jump-popover' });
		const rect = anchor.getBoundingClientRect();
		popover.style.top  = `${rect.bottom + 6}px`;
		popover.style.left = `${rect.left}px`;

		const input = popover.createEl('input', { type: 'date' });
		input.value = formatCalendarDate(new Date());

		const go = popover.createEl('button', { cls: 'mod-cta', text: 'Go' });
		go.addEventListener('click', () => {
			const d = this.parseRawFrontmatterDate(input.value);
			if (d) this._scrollToDate(d);
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

		// Only note.* properties are writable frontmatter fields — reject file.*/formula props
		if (!hintProp || !String(hintProp).startsWith('note.')) {
			new Notice('Timeline: drag-to-group is only supported for writable frontmatter properties (not file.* or formula properties)');
			return;
		}

		const file = this.app.vault.getFileByPath(entryPath);
		if (!file) return;

		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const groupByProp = String(hintProp).replace(/^note\./, '');

		const wasAbsent = !(groupByProp in fm);
		const oldValue = wasAbsent ? '__absent__' : String(fm[groupByProp] ?? '');

		this._pushUndo([{
			path: entryPath,
			startKey: groupByProp,
			endKey: '__group__',
			before: { start: oldValue, end: '__group__' },
			after:  { start: toGroupValue === 'Ungrouped' ? '__absent__' : toGroupValue, end: '__group__' },
		}]);

		try {
			await this.app.fileManager.processFrontMatter(file, (fmData) => {
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
			const { toPng } = await import('html-to-image');

			// Temporarily expand the scroller to show all content without scrollbars
			const scroller = el.querySelector('.bases-timeline-scroller') as HTMLElement | null;
			const saved: Array<{ el: HTMLElement; props: Record<string, string> }> = [];
			if (scroller) {
				const overrides: Record<string, string> = {
					overflow: 'visible',
					overflowX: 'visible',
					overflowY: 'visible',
					width: scroller.scrollWidth + 'px',
					height: scroller.scrollHeight + 'px',
				};
				saved.push({ el: scroller, props: {} });
				for (const [k, v] of Object.entries(overrides)) {
					saved[0].props[k] = scroller.style.getPropertyValue(k);
					scroller.style.setProperty(k, v, 'important');
				}
				// Also hide native scrollbar gutters on the body container
				if (getComputedStyle(el).overflow !== 'visible') {
					saved.push({ el, props: { overflow: el.style.overflow, overflowX: el.style.overflowX, overflowY: el.style.overflowY } });
					el.style.setProperty('overflow', 'visible', 'important');
					el.style.setProperty('overflow-x', 'visible', 'important');
					el.style.setProperty('overflow-y', 'visible', 'important');
				}
			}

			const dataUrl = await toPng(el, {
				backgroundColor: getComputedStyle(el).backgroundColor || '#fff',
				pixelRatio: window.devicePixelRatio || 1,
				style: {
					transform: 'none',
				},
			}).finally(() => {
				// Restore original styles
				for (const { el: restoreEl, props } of saved) {
					for (const [k, v] of Object.entries(props)) {
						if (v !== undefined && v !== '') restoreEl.style.setProperty(k, v);
						else restoreEl.style.removeProperty(k);
					}
				}
			});
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
		for (const path of this._selectedPaths) {
			this._barElsByPath.get(path)?.removeClass('is-selected');
		}
		this._selectedPaths.clear();
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
				const oldStart = formatCalendarDate(currentStart);
				const oldEnd   = formatCalendarDate(currentEnd);
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
		startInput.value = formatCalendarDate(currentStart);
		if (!startWritable) { startInput.disabled = true; startInput.title = 'Set by a formula — cannot be edited here'; }

		pop.createEl('label', { text: 'End', cls: 'tl-pop-label' });
		const endInput = pop.createEl('input', { type: 'date' });
		endInput.value = formatCalendarDate(currentEnd);
		if (!endWritable) { endInput.disabled = true; endInput.title = 'Set by a formula — cannot be edited here'; }

		const save = pop.createEl('button', { cls: 'mod-cta', text: 'Save' });
		save.addEventListener('click', async () => {
			pop.remove();
			const newStart = startInput.value;
			const newEnd   = endInput.value;
			if (!newStart || !newEnd) return;
			const before = { start: formatCalendarDate(currentStart), end: formatCalendarDate(currentEnd) };
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
					if (target.start === '__absent__') {
						delete fm[e.startKey]; // property was absent — restore by deleting
					} else {
						fm[e.startKey] = target.start;
					}
				} else {
					if (target.start === '__absent__') {
						delete fm[e.startKey];
					} else {
						fm[e.startKey] = target.start;
					}
					if (target.end === '__absent__') {
						delete fm[e.endKey];
					} else {
						fm[e.endKey] = target.end;
					}
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

	private _getRenderedDayStepPx(trackEl: HTMLElement): number | null {
		if (this._dayLabelSlots.length === 0) {
			const canvas = trackEl.closest('.bases-timeline-canvas');
			if (!(canvas instanceof HTMLElement)) return null;
			this.cacheDayLabelGeometry(canvas);
		}
		if (this._dayLabelSlots.length === 0) return null;
		const avg = this._dayLabelSlots.reduce((sum, slot) => sum + slot.width, 0) / this._dayLabelSlots.length;
		return avg > 0 ? avg : null;
	}

	private _getRenderedDayDateAtClientX(trackEl: HTMLElement, clientX: number): Date | null {
		const canvas = trackEl.closest('.bases-timeline-canvas');
		if (!(canvas instanceof HTMLElement)) return null;
		if (this._dayLabelSlots.length === 0) this.cacheDayLabelGeometry(canvas);
		const canvasRect = canvas.getBoundingClientRect();
		const xWithinCanvas = clientX - canvasRect.left;
		for (const slot of this._dayLabelSlots) {
			if (xWithinCanvas < slot.left || xWithinCanvas >= slot.right) continue;
			return slot.date;
		}
		return null;
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
		const trackRect = trackEl.getBoundingClientRect();
		const barRect = barEl.getBoundingClientRect();
		const lmStart = localMidnight(origStart);
		const lmEnd   = localMidnight(origEnd);
		const mouseAnchorDate = this._lastConfig?.timeScale === 'day' ? this._getRenderedDayDateAtClientX(trackEl, mouseX) : null;
		const spanDays = diffCalendarDays(lmStart, lmEnd);
		const mouseAnchorOffsetDays = mouseAnchorDate
			? Math.max(0, Math.min(spanDays, diffCalendarDays(lmStart, mouseAnchorDate)))
			: 0;
		this._dragState = {
			type, barEl, entryPath, startPropKey, endPropKey,
			origStart: lmStart,
			origEnd:   lmEnd,
			pendingStart: new Date(lmStart),
			pendingEnd:   new Date(lmEnd),
			mouseStartX: mouseX,
			trackWidth: trackEl.offsetWidth || 1,
			dayStepPx: this._lastConfig?.timeScale === 'day' ? this._getRenderedDayStepPx(trackEl) : null,
			mouseAnchorDate,
			mouseAnchorOffsetDays,
			barStartPx: barRect.left - trackRect.left,
			barEndPx: barRect.right - trackRect.left,
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

	private _cancelActiveDrag(): void {
		if (!this._dragState) return;
		this._dragState.barEl.removeClass('is-dragging');
		this._dragState = null;
		document.body.style.cursor = '';
		(document.body.style as CSSStyleDeclaration & { userSelect: string }).userSelect = '';
		this._dragTooltipEl?.remove();
		this._dragTooltipEl = null;
	}

	private _onDragMove(e: MouseEvent): void {
		// ── Draw mode (click-drag to set dates on a dateless row) ───────────
		if (this._draw) {
			const d     = this._draw;
			const rect  = d.trackEl.getBoundingClientRect();
			const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			const curDate = localMidnight(new Date(d.rangeMin.getTime() + pct * d.totalMs));
			const start = curDate < d.anchorDate ? curDate : d.anchorDate;
			const end   = curDate < d.anchorDate ? d.anchorDate : curDate;
			const startPct = ((start.getTime() - d.rangeMin.getTime()) / d.totalMs) * 100;
			const endPct   = ((addCalendarDays(end, 1).getTime() - d.rangeMin.getTime()) / d.totalMs) * 100;
			d.ghostEl.style.left  = `${startPct}%`;
			d.ghostEl.style.width = `${Math.max(endPct - startPct, 0.5)}%`;
			return;
		}
		if (!this._dragState) return;
		const s = this._dragState;

		const deltaPx = e.clientX - s.mouseStartX;
		const trackEl = s.barEl.parentElement!;
		const trackRect = trackEl.getBoundingClientRect();
		const currentMouseDate = s.mouseAnchorDate ? this._getRenderedDayDateAtClientX(s.barEl.parentElement!, e.clientX) : null;
		const startEdgeDate = this._lastConfig?.timeScale === 'day'
			? this._getRenderedDayDateAtClientX(trackEl, trackRect.left + s.barStartPx + deltaPx + 1)
			: null;
		const endEdgeDate = this._lastConfig?.timeScale === 'day'
			? this._getRenderedDayDateAtClientX(trackEl, trackRect.left + s.barEndPx + deltaPx - 1)
			: null;
		const deltaDays = s.mouseAnchorDate && currentMouseDate
			? diffCalendarDays(s.mouseAnchorDate, currentMouseDate)
			: s.dayStepPx
				? Math.round(deltaPx / s.dayStepPx)
				: Math.round((deltaPx / s.trackWidth) * (s.totalMs / 86400000));
		const dayMs = 86400000;
		const minWidthDays = 1; // bar never narrower than 1 day

		let newStart: Date, newEnd: Date;

		if (s.type === 'move') {
			({ start: newStart, end: newEnd } = resolveMovedRange({
				origStart: s.origStart,
				origEnd: s.origEnd,
				currentMouseDate,
				startEdgeDate,
				deltaDays,
				mouseAnchorDate: s.mouseAnchorDate,
				mouseAnchorOffsetDays: s.mouseAnchorOffsetDays,
			}));
			const leftPct = ((newStart.getTime() - s.rangeMin.getTime()) / s.totalMs) * 100;
			s.barEl.style.left = `${leftPct}%`;
			// width unchanged (duration preserved)

		} else if (s.type === 'resize-end') {
			({ start: newStart, end: newEnd } = resolveResizeEndRange({
				origStart: s.origStart,
				origEnd: s.origEnd,
				currentMouseDate,
				edgeDate: endEdgeDate,
				deltaDays,
				minWidthDays,
			}));
			const excl = addCalendarDays(newEnd, 1);
			const widthMs = Math.max(minWidthDays * dayMs, excl.getTime() - newStart.getTime());
			s.barEl.style.width = `${(widthMs / s.totalMs) * 100}%`;
			// left unchanged

		} else { // resize-start
			({ start: newStart, end: newEnd } = resolveResizeStartRange({
				origStart: s.origStart,
				origEnd: s.origEnd,
				currentMouseDate,
				edgeDate: startEdgeDate,
				deltaDays,
				minWidthDays,
			}));
			const leftPct = ((newStart.getTime() - s.rangeMin.getTime()) / s.totalMs) * 100;
			const excl = addCalendarDays(newEnd, 1);
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
		this.clearActiveDrawEndBinding();
		// ── Draw mode finish ─────────────────────────────────────────────────
		if (this._draw) {
			const d    = this._draw;
			this._draw = null;
			const rect = d.trackEl.getBoundingClientRect();
			const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			const curDate = localMidnight(new Date(d.rangeMin.getTime() + pct * d.totalMs));
			const start = curDate < d.anchorDate ? curDate : d.anchorDate;
			const end   = curDate < d.anchorDate ? d.anchorDate : curDate;
			d.ghostEl.remove();

			const startStr = formatCalendarDate(start);
			const endStr   = formatCalendarDate(end);

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
		const deltaDays = diffCalendarDays(s.origStart, newStart);

		// Build list of bars to update: the dragged bar + any other selected bars (move only)
		const toUpdate: UndoRecord['entries'] = [];

		// Primary bar
		const primaryFile = this.app.vault.getFileByPath(s.entryPath);
		if (primaryFile) {
			const before = { start: formatCalendarDate(s.origStart), end: formatCalendarDate(s.origEnd) };
			const after  = { start: formatCalendarDate(newStart),    end: formatCalendarDate(newEnd) };
			toUpdate.push({ path: s.entryPath, startKey: s.startPropKey, endKey: s.endPropKey, before, after });
			try {
				await this.app.fileManager.processFrontMatter(primaryFile, fm => {
					fm[s.startPropKey] = after.start;
					fm[s.endPropKey]   = after.end;
				});
			} catch (err) { console.error('[Timeline] Failed to update frontmatter:', err); }
		}

		// Bulk-move other selected bars (only for 'move' type)
		if (s.type === 'move' && this._selectedPaths.size > 1 && deltaDays !== 0) {
			const otherPaths = Array.from(this._selectedPaths).filter(path => path !== s.entryPath);

			for (const path of otherPaths) {
				const file = this.app.vault.getFileByPath(path);
				if (!file) continue;

				const fmCache = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fmCache) continue;
				const oldStartStr = fmCache[s.startPropKey];
				const oldEndStr   = fmCache[s.endPropKey];
				if (!oldStartStr || !oldEndStr) continue;

				const oldS = this.parseRawFrontmatterDate(oldStartStr);
				const oldE = this.parseRawFrontmatterDate(oldEndStr);
				if (!oldS || !oldE) continue;
				const newS = addCalendarDays(oldS, deltaDays);
				const newE = addCalendarDays(oldE, deltaDays);

				const before = { start: formatCalendarDate(oldS), end: formatCalendarDate(oldE) };
				const after  = { start: formatCalendarDate(newS), end: formatCalendarDate(newE) };
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

	private getEntryDates(entry: BasesEntry, startProp: BasesPropertyId | null, endProp: BasesPropertyId | null): { start: Date; end: Date; isPoint: boolean; isInvalid?: boolean } | null {
		if (!startProp || !endProp) return null;

		const startValue = entry.getValue(startProp);
		const endValue = entry.getValue(endProp);
		let start = this.parseDateValue(startValue);
		let end = this.parseDateValue(endValue);

		const hasStartValue = Boolean(startValue && startValue.isTruthy());
		const hasEndValue   = Boolean(endValue && endValue.isTruthy());

		// Neither date: not renderable
		if (!hasStartValue && !hasEndValue) return null;

		// End-only: use end as start (1-day bar)
		if (!hasStartValue && end) {
			return { start: end, end: new Date(end.getTime()), isPoint: true };
		}

		if (!start) return null;

		// Start-only: 1-day bar
		if (!hasEndValue || !end) {
			return { start, end: new Date(start.getTime()), isPoint: true };
		}

		// Both present but start > end: flag as invalid, swap for rendering
		if (start.getTime() > end.getTime()) {
			return { start: end, end: start, isPoint: false, isInvalid: true };
		}

		return { start, end, isPoint: false };
	}

	private parseCalendarDateString(text: string): Date | null {
		return parseStrictCalendarDateString(text);
	}

	/** Parse a raw frontmatter value (string | number | Date) into a Date, or null if invalid. */
	private parseRawFrontmatterDate(raw: unknown): Date | null {
		return parseStrictRawFrontmatterDate(raw);
	}

	private parseDateValue(value: Value | null): Date | null {
		if (!value || !value.isTruthy()) return null;

		if (value instanceof DateValue) {
			return this.parseCalendarDateString(value.toString());
		}

		const text = value.toString();
		const parsed = this.parseCalendarDateString(text);
		if (parsed) return parsed;

		const dateValue = DateValue.parseFromString(text);
		if (dateValue) {
			return this.parseCalendarDateString(dateValue.toString());
		}

		return null;
	}

	private getUniqueStyleValues(styleProp: BasesPropertyId): string[] {
		const values = new Set<string>();
		for (const entry of this.data.data) {
			const value = entry.getValue(styleProp);
			if (!value || !value.isTruthy()) continue;
			values.add(value.toString());
		}
		return Array.from(values).sort((a, b) => a.localeCompare(b));
	}

	private getEntryStyleColor(entry: BasesEntry, styleProp: BasesPropertyId | null, styleMap: Record<string, string>): string | null {
		if (!styleProp) return null;
		const value = entry.getValue(styleProp);
		if (!value || !value.isTruthy()) return null;
		const key = value.toString();
		return styleMap[key] || null;
	}

	private applyFillColorToBars(colorValue: string, newColor: string): void {
		this.containerEl.querySelectorAll<HTMLElement>(`.bases-timeline-bar[data-color-value="${CSS.escape(colorValue)}"]`).forEach(bar => {
			bar.style.backgroundColor = newColor;
		});
		this.updateStyleControlDot('fill', colorValue, newColor);
	}

	private applyBorderColorToBars(colorValue: string, newColor: string): void {
		this.containerEl.querySelectorAll<HTMLElement>(`.bases-timeline-bar[data-border-value="${CSS.escape(colorValue)}"]`).forEach(bar => {
			bar.style.borderColor = newColor;
			bar.style.setProperty('--tl-bar-border-color', newColor);
		});
		this.updateStyleControlDot('border', colorValue, newColor);
	}

	private updateStyleControlDot(role: 'fill' | 'border', colorValue: string, newColor: string): void {
		const section = this.controlsEl.querySelector<HTMLElement>(`.bases-timeline-style-section[data-style-role="${role}"]`);
		if (!section) return;
		section.querySelectorAll<HTMLElement>('.bases-timeline-color-item').forEach(item => {
			const label = item.querySelector('.bases-timeline-color-label');
			if (label?.textContent === colorValue) {
				const dot = item.querySelector('.bases-timeline-swatch.is-current') as HTMLElement | null;
				if (dot) dot.style.background = newColor;
			}
		});
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

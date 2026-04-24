# Border-by-property Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a second styling dimension to timeline bars so users can map one property to fill color and another property to the bar border color.

**Architecture:** Extend the existing `colorBy` / `colorMap` pipeline with a parallel `borderBy` / `borderColorMap` pipeline. Reuse the proven Bases custom-key persistence pattern already used for timeline custom config, and refactor the current color controls/render helpers just enough to avoid duplicating the same property-selector + swatch UI twice.

**Tech Stack:** Obsidian plugin API, TypeScript, Bases custom view config persistence in `.base` YAML, existing `node:test` tests, CSS in `styles.css`.

---

## Feature definition

### User-visible behavior
- Add a new config control: **Border by:**
- Users can select a second property, independent from **Color by:**
- For each unique value of the chosen property, users can assign a border color from the existing palette
- Bars render with:
  - fill color from `colorBy` / `colorMap`
  - border color from `borderBy` / `borderColorMap`
- If `borderBy` is unset, bars keep the existing default neutral border
- Selection outline (`.is-selected`) remains separate and still uses the accent outline

### Persistence definition
Persist these new view-local keys in the `.base` file alongside existing custom keys:
- `borderBy`
- `borderColorMap`

Expected YAML shape:

```yaml
views:
  - type: timeline
    name: My Timeline
    colorBy: note.status
    colorMap: 'Open=#f59f00;Done=#2f9e44'
    borderBy: note.priority
    borderColorMap: 'High=#e03131;Medium=#f08c00;Low=#339af0'
```

---

## Files to modify

### Primary implementation
- Modify: `src/timeline-view.ts`
- Modify: `styles.css`
- Modify: `src/main.ts`

### Tests
- Modify: `tests/timeline-persistence.test.ts`
- Create: `tests/timeline-border-config.test.ts`

### Docs
- Modify: `README.md`

---

## Task 1: Extend the config model for border styling

**Objective:** Add border-property state to `TimelineConfig` and make `loadConfig()` populate it.

**Files:**
- Modify: `src/timeline-view.ts` (`TimelineConfig` interface near lines 36-62, `loadConfig()` near lines 282-362)

**Step 1: Update `TimelineConfig`**

Add two fields beside the existing fill-color fields:

```ts
interface TimelineConfig {
	startDateProp: BasesPropertyId | null;
	endDateProp: BasesPropertyId | null;
	primaryProp: BasesPropertyId | null;
	orderedProps: BasesPropertyId[];
	colorProp: BasesPropertyId | null;
	colorMap: Record<string, string>;
	borderProp: BasesPropertyId | null;
	borderColorMap: Record<string, string>;
	zoom: number;
	// ...existing fields unchanged...
}
```

**Step 2: Load the new config fields in `loadConfig()`**

Read the new property and map using the same persistence path as the existing fill config:

```ts
const colorProp = this.getPropertyIdFromConfig('colorBy');
const colorMap = this.getEncodedColorMapFromConfig('colorMap');
const borderProp = this.getPropertyIdFromConfig('borderBy');
const borderColorMap = this.getEncodedColorMapFromConfig('borderColorMap');
```

Return them from `loadConfig()`:

```ts
return {
	startDateProp,
	endDateProp,
	primaryProp,
	orderedProps,
	colorProp,
	colorMap,
	borderProp,
	borderColorMap,
	zoom,
	// ...rest unchanged...
};
```

**Step 3: Introduce a generalized map-reader helper**

Replace the current fill-only helper:

```ts
private getColorMapFromConfig(): Record<string, string>
```

with a generic helper that accepts the config key:

```ts
private getEncodedColorMapFromConfig(key: string): Record<string, string> {
	const raw = this.getViewConfigValue(key);
	if (typeof raw === 'string') return this.decodeMap(raw);
	if (raw && typeof raw === 'object') return { ...(raw as Record<string, string>) };
	return {};
}
```

Then update fill-color call sites to use `getEncodedColorMapFromConfig('colorMap')`.

**Step 4: Run typecheck via build**

Run:
```bash
npm run build
```

Expected: TypeScript passes, even if later tasks still fail functional tests.

**Step 5: Commit**

```bash
git add src/timeline-view.ts
git commit -m "feat: add border color config model"
```

---

## Task 2: Persist `borderBy` and `borderColorMap` in `.base` YAML

**Objective:** Extend the existing custom-key persistence pipeline so border styling survives render cycles and full reloads.

**Files:**
- Modify: `src/timeline-view.ts` (`setViewConfigValue`, `_persistCustomKeysDirect`, `_persistCustomKeys`, any helper comments)
- Test: `tests/timeline-border-config.test.ts`

**Step 1: Extend the custom-key lists**

In both `_persistCustomKeysDirect()` and `_persistCustomKeys()`, update the custom key arrays.

From:

```ts
const CUSTOM_STRING_KEYS = ['colorMap', 'propColWidths', 'collapsedGroups'];
const CUSTOM_STRING_SCALAR_KEYS = ['timeScale', 'showColors', 'colorBy'];
```

To:

```ts
const CUSTOM_STRING_KEYS = ['colorMap', 'borderColorMap', 'propColWidths', 'collapsedGroups'];
const CUSTOM_STRING_SCALAR_KEYS = ['timeScale', 'showColors', 'colorBy', 'borderBy'];
```

**Step 2: Keep `persistOnly=true` for new border keys**

All `borderBy` / `borderColorMap` writes should go through:

```ts
this.setViewConfigValue('borderBy', value, true);
this.setViewConfigValue('borderColorMap', this.encodeMap(map), true);
```

Do **not** use `persistOnly=false` for these custom keys. They are undeclared Bases keys and must follow the established direct-write path.

**Step 3: Write a focused persistence test file**

Create `tests/timeline-border-config.test.ts` with isolated pure-function tests around config encoding assumptions. Keep it lightweight; do not try to instantiate the full Obsidian view.

Suggested test contents:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

function encodeMap(map: Record<string, string>): string {
	return Object.entries(map).map(([k, v]) => `${k}=${v}`).join(';');
}

function decodeMap(encoded: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!encoded) return result;
	for (const pair of encoded.split(';')) {
		const idx = pair.indexOf('=');
		if (idx > 0) result[pair.slice(0, idx)] = pair.slice(idx + 1);
	}
	return result;
}

test('borderColorMap round-trips as semicolon-delimited YAML-safe string', () => {
	const encoded = encodeMap({ High: '#e03131', Medium: '#f59f00' });
	assert.equal(encoded, 'High=#e03131;Medium=#f59f00');
	assert.deepEqual(decodeMap(encoded), { High: '#e03131', Medium: '#f59f00' });
});
```

If you prefer less duplication, extract pure map helpers into a dedicated module first and test the real helpers instead. That is acceptable if kept small.

**Step 4: Run tests**

Run:
```bash
npm test
```

Expected: all existing tests pass plus the new border-config test.

**Step 5: Commit**

```bash
git add src/timeline-view.ts tests/timeline-border-config.test.ts
git commit -m "feat: persist border color timeline settings"
```

---

## Task 3: Refactor fill-color control rendering into a reusable helper

**Objective:** Avoid duplicating the full controls UI for fill and border mappings.

**Files:**
- Modify: `src/timeline-view.ts` (`renderControls()` and helper methods near lines 840-944 and 3748-3793)

**Step 1: Introduce a small config shape for style-mapping controls**

Add an internal helper type near `TimelineConfig` or near the controls methods:

```ts
interface StyleMappingControlConfig {
	label: string;
	propKey: 'colorBy' | 'borderBy';
	mapKey: 'colorMap' | 'borderColorMap';
	selectedProp: BasesPropertyId | null;
	selectedMap: Record<string, string>;
	applyToBars: (value: string, color: string) => void;
}
```

**Step 2: Extract the repeated UI logic from `renderControls()`**

Create a helper such as:

```ts
private renderStyleMappingControls(config: TimelineConfig, control: StyleMappingControlConfig): void {
	const allProps = [...(this.allProperties ?? [])].sort((a, b) =>
		this.getPropertyName(a).localeCompare(this.getPropertyName(b))
	);

	const propRowEl = this.controlsEl.createDiv({ cls: 'bases-timeline-config-row' });
	propRowEl.createSpan({ cls: 'bases-timeline-config-label', text: `${control.label}:` });

	const propSelect = propRowEl.createEl('select', { cls: 'bases-timeline-config-select' });
	propSelect.createEl('option', { value: '', text: '— none —' });
	allProps.forEach(prop => {
		const name = this.getPropertyName(prop);
		const opt = propSelect.createEl('option', { value: JSON.stringify(prop), text: name });
		if (control.selectedProp && JSON.stringify(control.selectedProp) === JSON.stringify(prop)) {
			opt.selected = true;
		}
	});

	propSelect.addEventListener('change', () => {
		const val = propSelect.value;
		if (!val) {
			this.setViewConfigValue(control.propKey, null, true);
		} else {
			try {
				this.setViewConfigValue(control.propKey, JSON.parse(val), true);
			} catch {}
		}
		this.render();
	});

	if (!control.selectedProp) return;

	const allUniqueValues = this.getUniqueMappedValues(control.selectedProp);
	const { colorMap, changed } = this.ensureColorMap(control.selectedMap, allUniqueValues);
	if (changed) {
		this.setViewConfigValue(control.mapKey, this.encodeMap(colorMap), true);
		control.selectedMap = colorMap;
	}

	if (allUniqueValues.length === 0) {
		this.controlsEl.createDiv({ cls: 'bases-timeline-controls-empty', text: 'No values found for the selected property.' });
		return;
	}

	// Keep the existing MAX_COLOR_VALUES cap and swatch popup behavior.
}
```

**Step 3: Rename generic helpers to match their broader role**

Recommended renames:
- `getUniqueColorValues` → `getUniqueMappedValues`
- `getEntryColor` → `getEntryMappedColor`

Suggested implementations:

```ts
private getUniqueMappedValues(prop: BasesPropertyId): string[] {
	const values = new Set<string>();
	for (const entry of this.data.data) {
		const value = entry.getValue(prop);
		if (!value || !value.isTruthy()) continue;
		values.add(value.toString());
	}
	return Array.from(values).sort((a, b) => a.localeCompare(b));
}

private getEntryMappedColor(
	entry: BasesEntry,
	prop: BasesPropertyId | null,
	map: Record<string, string>
): string | null {
	if (!prop) return null;
	const value = entry.getValue(prop);
	if (!value || !value.isTruthy()) return null;
	const key = value.toString();
	return map[key] || null;
}
```

**Step 4: Replace `renderControls()` body with two helper calls**

After the controls visibility check, call:

```ts
this.renderStyleMappingControls(config, {
	label: 'Color by',
	propKey: 'colorBy',
	mapKey: 'colorMap',
	selectedProp: config.colorProp,
	selectedMap: config.colorMap,
	applyToBars: (value, color) => this.applyFillColorToBars(value, color),
});

this.renderStyleMappingControls(config, {
	label: 'Border by',
	propKey: 'borderBy',
	mapKey: 'borderColorMap',
	selectedProp: config.borderProp,
	selectedMap: config.borderColorMap,
	applyToBars: (value, color) => this.applyBorderColorToBars(value, color),
});
```

**Step 5: Run build**

Run:
```bash
npm run build
```

Expected: no type errors and no unused helper leftovers.

**Step 6: Commit**

```bash
git add src/timeline-view.ts
git commit -m "refactor: reuse style mapping controls for fill and border"
```

---

## Task 4: Render border colors on bars and support in-place border updates

**Objective:** Make bars visibly reflect the second property mapping without a full rerender after each swatch click.

**Files:**
- Modify: `src/timeline-view.ts` (bar rendering near lines 2720-2738 and apply-color helpers near lines 3769-3793)
- Modify: `styles.css` (bar styling near lines 1325-1405)

**Step 1: Add border data attributes during bar render**

Update the bar render path.

From:

```ts
const color = this.getEntryColor(entry, config.colorProp, config.colorMap);
if (color) {
	barEl.style.backgroundColor = color;
}
if (config.colorProp) {
	const colorVal = entry.getValue(config.colorProp);
	if (colorVal?.isTruthy()) {
		barEl.setAttribute('data-color-value', colorVal.toString());
	}
}
```

To:

```ts
const fillColor = this.getEntryMappedColor(entry, config.colorProp, config.colorMap);
if (fillColor) {
	barEl.style.backgroundColor = fillColor;
}

const borderColor = this.getEntryMappedColor(entry, config.borderProp, config.borderColorMap);
if (borderColor) {
	barEl.style.borderColor = borderColor;
	barEl.style.setProperty('--tl-bar-border-color', borderColor);
}

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
```

**Step 2: Split `applyColorToBars()` into fill + border helpers**

Rename the current method to `applyFillColorToBars()` and add a border variant:

```ts
private applyFillColorToBars(colorValue: string, newColor: string): void {
	this.containerEl
		.querySelectorAll<HTMLElement>(`.bases-timeline-bar[data-color-value="${CSS.escape(colorValue)}"]`)
		.forEach(bar => {
			bar.style.backgroundColor = newColor;
		});
	this.updateControlDot('Color by', colorValue, newColor);
}

private applyBorderColorToBars(colorValue: string, newColor: string): void {
	this.containerEl
		.querySelectorAll<HTMLElement>(`.bases-timeline-bar[data-border-value="${CSS.escape(colorValue)}"]`)
		.forEach(bar => {
			bar.style.borderColor = newColor;
			bar.style.setProperty('--tl-bar-border-color', newColor);
		});
	this.updateControlDot('Border by', colorValue, newColor);
}
```

**Step 3: Make control-dot updating explicit instead of fragile**

The current `applyColorToBars()` tries to locate the correct dot by matching labels in the whole controls pane. That becomes ambiguous with two style sections. Add a more explicit mechanism:
- put a section wrapper around each control block, e.g. `.bases-timeline-style-section`
- include `data-style-role="fill"` or `data-style-role="border"`
- scope swatch updates within that section only

Suggested helper:

```ts
private updateControlDot(role: 'fill' | 'border', value: string, color: string): void {
	const section = this.controlsEl.querySelector<HTMLElement>(`.bases-timeline-style-section[data-style-role="${role}"]`);
	if (!section) return;
	section.querySelectorAll<HTMLElement>('.bases-timeline-color-item').forEach(item => {
		const label = item.querySelector('.bases-timeline-color-label');
		if (label?.textContent === value) {
			const dot = item.querySelector('.bases-timeline-swatch.is-current') as HTMLElement | null;
			if (dot) dot.style.background = color;
		}
	});
}
```

Then make the fill helper call `updateControlDot('fill', ...)` and the border helper call `updateControlDot('border', ...)`.

**Step 4: Adjust CSS so border styling is actually visible**

Current bar CSS has:

```css
.bases-timeline-bar {
	border: 1px solid rgba(0, 0, 0, 0.1);
}
```

Change to a CSS-variable-based border so runtime updates are predictable:

```css
.bases-timeline-bar {
	--tl-bar-border-color: rgba(0, 0, 0, 0.1);
	border: 1px solid var(--tl-bar-border-color);
}
```

If testing shows 1px is too subtle, use a stronger inset ring while preserving hover effects carefully. Do **not** ship a brittle box-shadow implementation unless you verify hover, selection, and drag states together.

**Step 5: Manual verification in live Obsidian**

After implementation:

```bash
npm run build
npm run push:nexus
sudo -u kunicki env XDG_RUNTIME_DIR=/run/user/1000 HOME=/home/kunicki /home/kunicki/.local/bin/obsidian reload
```

Verify in the vault:
1. Open a `.base` using the timeline view
2. Set **Color by** to `status`
3. Set **Border by** to `priority`
4. Assign different colors for a few priority values
5. Confirm bars show both fill and border colors
6. Change a border swatch and confirm bars update without full rerender
7. Reload Obsidian and confirm the settings persist

**Step 6: Commit**

```bash
git add src/timeline-view.ts styles.css
git commit -m "feat: render timeline bar borders by property"
```

---

## Task 5: Add regression tests for border config behavior

**Objective:** Prove the new border config reads/writes safely and doesn’t regress the map-encoding pattern.

**Files:**
- Modify: `tests/timeline-persistence.test.ts`
- Modify/Create: `tests/timeline-border-config.test.ts`

**Step 1: Add tests for the new config naming assumptions**

Suggested small tests:

```ts
test('borderBy and borderColorMap are valid custom timeline config keys', () => {
	const scalarKeys = ['timeScale', 'showColors', 'colorBy', 'borderBy'];
	const stringKeys = ['colorMap', 'borderColorMap', 'propColWidths', 'collapsedGroups'];

	assert.ok(scalarKeys.includes('borderBy'));
	assert.ok(stringKeys.includes('borderColorMap'));
});
```

If you extract shared constants from `timeline-view.ts` into a small pure module (recommended), test those real constants instead of repeating the arrays in the test.

**Step 2: Add a round-trip test for border config maps with dotted keys or CSS-function values if the helper is extracted**

Suggested assertion:

```ts
test('borderColorMap preserves plain keys and CSS-safe values', () => {
	const encoded = 'High=var(--color-red);Medium=color-mix(in srgb, var(--color-orange) 55%, white)';
	assert.deepEqual(decodeMap(encoded), {
		High: 'var(--color-red)',
		Medium: 'color-mix(in srgb, var(--color-orange) 55%, white)',
	});
});
```

This is worth adding because the repo’s persistence code is sensitive to YAML-safe string encodings.

**Step 3: Run tests**

Run:
```bash
npm test
```

Expected: green test suite.

**Step 4: Commit**

```bash
git add tests/timeline-persistence.test.ts tests/timeline-border-config.test.ts
git commit -m "test: cover border color config persistence"
```

---

## Task 6: Update sample base and README

**Objective:** Document the new capability and provide an example in the generated sample timeline base.

**Files:**
- Modify: `src/main.ts`
- Modify: `README.md`

**Step 1: Update sample `.base` generation in `src/main.ts`**

In the generated example view config, add a simple border mapping:

```ts
    colorBy: note.priority
    colorMap:
      High: "#e03131"
      Medium: "#f59f00"
      Low: "#2f9e44"
    borderBy: note.status
    borderColorMap: 'open=#339af0;done=#868e96'
```

If the sample currently relies on YAML object syntax for `colorMap`, consider leaving the sample as-is unless you have confirmed the current sample generation path is stable. For the new key, prefer the same storage format the runtime actually uses.

**Step 2: Update README feature list succinctly**

Add one brief bullet under task bar styling or features:

```md
- **Dual property styling** — map one property to bar fill and another to the bar border
```

**Step 3: Run build**

Run:
```bash
npm run build
```

Expected: build succeeds.

**Step 4: Commit**

```bash
git add src/main.ts README.md
git commit -m "docs: document border styling by property"
```

---

## Verification checklist

Run this complete verification flow before calling the feature done:

```bash
npm test
npm run build
npm run push:nexus
sudo -u kunicki env XDG_RUNTIME_DIR=/run/user/1000 HOME=/home/kunicki /home/kunicki/.local/bin/obsidian reload
```

### Live verification checklist
- [ ] Timeline view still opens with no console/runtime errors
- [ ] Existing `Color by` fill coloring still works
- [ ] New `Border by` selector appears in the config panel
- [ ] Border swatches appear only when a border property is selected
- [ ] Border color changes update visible bars immediately
- [ ] Selection outline still appears on selected bars
- [ ] Hover/drag/resize visuals still look correct with colored borders
- [ ] `borderBy` and `borderColorMap` persist in the `.base` file
- [ ] Full `obsidian reload` preserves border styling
- [ ] No infinite rerender loop occurs after changing border colors

---

## Notes / pitfalls

### 1. Keep `borderBy` in the custom scalar key list
`borderBy` is analogous to `colorBy`, which is already an undeclared custom key. If you forget to add `borderBy` to the scalar custom-key arrays, it will appear to work transiently, then disappear after a render/reload cycle.

### 2. Keep `borderColorMap` encoded as a string
Do not persist it as a YAML object. Follow the same semicolon-delimited string pattern as `colorMap` so Bases doesn’t strip or rewrite it unexpectedly.

### 3. Avoid ambiguous control-dot updates
Once there are two style sections, any DOM update helper that only matches the value label globally can update the wrong section. Scope updates by section role.

### 4. Verify border visibility before overengineering
Start with `borderColor`. Only move to a more complex box-shadow or pseudo-element approach if the border is too subtle in practice.

### 5. Preserve current selection and hover semantics
Selection uses `outline`; hover modifies `box-shadow` and transform. Border styling should not break either of these states.

---

## Final deliverable summary

When complete, the plugin should support:
- `Color by` → fill color
- `Border by` → bar border color
- independent swatch mappings for both
- persistence across save/reload
- live in-place updates for both fill and border colors

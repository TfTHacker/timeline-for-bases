import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	CUSTOM_NUMERIC_KEYS,
	CUSTOM_STRING_KEYS,
	CUSTOM_STRING_SCALAR_KEYS,
	decodeStyleMap,
	encodeStyleMap,
	getClampedBorderWidth,
	getCompleteStyleMap,
} from '../src/timeline-style-config';

test('borderBy, borderColorMap, and borderWidth are included in timeline custom config key lists', () => {
	assert.ok(CUSTOM_STRING_KEYS.includes('borderColorMap'));
	assert.ok(CUSTOM_STRING_SCALAR_KEYS.includes('borderBy'));
	assert.ok(CUSTOM_NUMERIC_KEYS.includes('borderWidth'));
});

test('borderColorMap round-trips through YAML-safe semicolon encoding', () => {
	const encoded = encodeStyleMap({ High: '#e03131', Medium: '#f59f00' });
	assert.equal(encoded, 'High=#e03131;Medium=#f59f00');
	assert.deepEqual(decodeStyleMap(encoded), { High: '#e03131', Medium: '#f59f00' });
});

test('decodeStyleMap preserves plain dotted keys and CSS function values', () => {
	const encoded = 'note.priority=var(--color-red);Task.md=color-mix(in srgb, var(--color-orange) 55%, white)';
	assert.deepEqual(decodeStyleMap(encoded), {
		'note.priority': 'var(--color-red)',
		'Task.md': 'color-mix(in srgb, var(--color-orange) 55%, white)',
	});
});

test('getCompleteStyleMap assigns defaults only to missing values', () => {
	const result = getCompleteStyleMap({ blocked: '#111111' }, ['blocked', 'done', 'planned'], ['#111111', '#222222']);
	assert.deepEqual(result, {
		styleMap: {
			blocked: '#111111',
			done: '#222222',
			planned: '#111111',
		},
		changed: true,
	});
});

test('getClampedBorderWidth constrains values to 1px–4px with a configurable default', () => {
	assert.equal(getClampedBorderWidth(undefined), 2);
	assert.equal(getClampedBorderWidth(undefined, 1), 1);
	assert.equal(getClampedBorderWidth(null), 2);
	assert.equal(getClampedBorderWidth(0), 1);
	assert.equal(getClampedBorderWidth(1), 1);
	assert.equal(getClampedBorderWidth('3'), 3);
	assert.equal(getClampedBorderWidth(4), 4);
	assert.equal(getClampedBorderWidth(7), 4);
	assert.equal(getClampedBorderWidth('nope'), 2);
});

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	formatTickLabel,
	getAxisFormatter,
	getIsoWeekNumber,
	getMinorGridTicks,
	getScaleZoomFactor,
	getTicksForScale,
	reduceTicks,
	snapEndToScale,
	snapStartToScale,
} from '../src/timeline-axis';
import { formatCalendarDate, parseCalendarDateString } from '../src/timeline-date';

const d = (s: string) => parseCalendarDateString(s)!;

test('getTicksForScale day scale returns one tick per calendar day inclusive', () => {
	const ticks = getTicksForScale(d('2026-04-01'), d('2026-04-05'), 'day');
	assert.deepEqual(ticks.map(formatCalendarDate), [
		'2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05',
	]);
});

test('getTicksForScale week scale anchors to the configured weekStart', () => {
	// 2026-04-01 is a Wednesday. Monday-anchored week starts 2026-03-30.
	const monday = getTicksForScale(d('2026-04-01'), d('2026-04-15'), 'week', 'monday');
	assert.equal(formatCalendarDate(monday[0]), '2026-03-30');
	// Sunday-anchored week starts 2026-03-29.
	const sunday = getTicksForScale(d('2026-04-01'), d('2026-04-15'), 'week', 'sunday');
	assert.equal(formatCalendarDate(sunday[0]), '2026-03-29');
});

test('getTicksForScale month scale returns first-of-month ticks', () => {
	const ticks = getTicksForScale(d('2026-02-15'), d('2026-05-10'), 'month');
	assert.deepEqual(ticks.map(formatCalendarDate), [
		'2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01',
	]);
});

test('getTicksForScale falls back to a single tick when range collapses', () => {
	const ticks = getTicksForScale(d('2026-04-10'), d('2026-04-09'), 'day');
	assert.equal(ticks.length, 1);
});

test('getMinorGridTicks yields daily subdivisions at week scale', () => {
	const ticks = getMinorGridTicks(d('2026-04-01'), d('2026-04-03'), 'week', 'monday');
	assert.deepEqual(ticks.map(formatCalendarDate), ['2026-04-01', '2026-04-02', '2026-04-03']);
});

test('reduceTicks only thins out quarter-scale ticks beyond the visible cap', () => {
	const many = Array.from({ length: 40 }, (_, i) => new Date(2026, i % 12, 1));
	assert.equal(reduceTicks(many, 'day').length, 40, 'day scale never reduces');
	assert.ok(reduceTicks(many, 'quarter').length <= 17, 'quarter scale reduces to roughly maxVisible');
});

test('getScaleZoomFactor returns calibrated multipliers per scale', () => {
	assert.equal(getScaleZoomFactor('day'), 2.4);
	assert.equal(getScaleZoomFactor('week'), 3.1);
	assert.equal(getScaleZoomFactor('quarter'), 1);
	assert.equal(getScaleZoomFactor('unknown'), 1);
});

test('snapStartToScale and snapEndToScale bracket the enclosing bucket', () => {
	const monthStart = snapStartToScale(d('2026-04-15'), 'month');
	const monthEnd = snapEndToScale(d('2026-04-15'), 'month');
	assert.equal(formatCalendarDate(monthStart), '2026-04-01');
	assert.equal(formatCalendarDate(monthEnd), '2026-04-30');

	const quarterStart = snapStartToScale(d('2026-05-15'), 'quarter');
	const quarterEnd = snapEndToScale(d('2026-05-15'), 'quarter');
	assert.equal(formatCalendarDate(quarterStart), '2026-04-01');
	assert.equal(formatCalendarDate(quarterEnd), '2026-06-30');
});

test('getIsoWeekNumber matches ISO 8601 week numbering', () => {
	assert.equal(getIsoWeekNumber(d('2026-01-01')), 1);
	assert.equal(getIsoWeekNumber(d('2026-04-23')), 17);
	assert.equal(getIsoWeekNumber(d('2025-12-29')), 1);
});

test('formatTickLabel uses W-prefix for weeks and Q-prefix for quarters', () => {
	const fmt = new Intl.DateTimeFormat('en-US', { month: 'short' });
	assert.equal(formatTickLabel(d('2026-01-05'), 'week', fmt), 'W2');
	assert.equal(formatTickLabel(d('2026-07-01'), 'quarter', fmt), 'Q3');
	assert.equal(formatTickLabel(d('2026-07-01'), 'month', fmt), 'Jul');
});

test('getAxisFormatter picks narrower formats for narrower windows', () => {
	const shortWindow = getAxisFormatter(d('2026-04-01'), d('2026-04-10'));
	const wideWindow = getAxisFormatter(d('2020-01-01'), d('2026-01-01'));
	// We can't assert exact strings across locales, but resolvedOptions lets us verify intent.
	assert.ok(shortWindow.resolvedOptions().day, 'short windows include day precision');
	assert.ok(wideWindow.resolvedOptions().year && !wideWindow.resolvedOptions().month, 'wide windows drop to year only');
});

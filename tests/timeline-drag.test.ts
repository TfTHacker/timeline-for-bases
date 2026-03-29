import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	resolveMovedRange,
	resolveResizeEndRange,
	resolveResizeStartRange,
} from '../src/timeline-drag';
import { formatCalendarDate, parseCalendarDateString } from '../src/timeline-date';

test('resolveMovedRange preserves the cursor anchor inside the bar', () => {
	const result = resolveMovedRange({
		origStart: parseCalendarDateString('2026-03-31')!,
		origEnd: parseCalendarDateString('2026-04-01')!,
		currentMouseDate: parseCalendarDateString('2026-04-04'),
		startEdgeDate: null,
		deltaDays: 0,
		mouseAnchorDate: parseCalendarDateString('2026-04-03'),
		mouseAnchorOffsetDays: 1,
	});

	assert.equal(formatCalendarDate(result.start), '2026-04-03');
	assert.equal(formatCalendarDate(result.end), '2026-04-04');
});

test('resolveMovedRange falls back to day deltas when no rendered day geometry is available', () => {
	const result = resolveMovedRange({
		origStart: parseCalendarDateString('2026-03-28')!,
		origEnd: parseCalendarDateString('2026-03-30')!,
		currentMouseDate: null,
		startEdgeDate: null,
		deltaDays: 2,
		mouseAnchorDate: null,
		mouseAnchorOffsetDays: 0,
	});

	assert.equal(formatCalendarDate(result.start), '2026-03-30');
	assert.equal(formatCalendarDate(result.end), '2026-04-01');
});

test('resolveResizeEndRange clamps to a minimum width of one day', () => {
	const result = resolveResizeEndRange({
		origStart: parseCalendarDateString('2026-03-29')!,
		origEnd: parseCalendarDateString('2026-04-02')!,
		currentMouseDate: parseCalendarDateString('2026-03-28'),
		edgeDate: null,
		deltaDays: -4,
		minWidthDays: 1,
	});

	assert.equal(formatCalendarDate(result.start), '2026-03-29');
	assert.equal(formatCalendarDate(result.end), '2026-03-29');
});

test('resolveResizeStartRange clamps to a minimum width of one day', () => {
	const result = resolveResizeStartRange({
		origStart: parseCalendarDateString('2026-03-29')!,
		origEnd: parseCalendarDateString('2026-04-02')!,
		currentMouseDate: parseCalendarDateString('2026-04-03'),
		edgeDate: null,
		deltaDays: 5,
		minWidthDays: 1,
	});

	assert.equal(formatCalendarDate(result.start), '2026-04-02');
	assert.equal(formatCalendarDate(result.end), '2026-04-02');
});

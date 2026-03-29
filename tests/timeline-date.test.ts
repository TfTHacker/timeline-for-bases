import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	addCalendarDays,
	diffCalendarDays,
	formatCalendarDate,
	parseCalendarDateString,
	parseRawFrontmatterDate,
} from '../src/timeline-date';

test('parseCalendarDateString keeps ISO date-only values on the same calendar day', () => {
	const parsed = parseCalendarDateString('2026-03-29');
	assert.ok(parsed);
	assert.equal(formatCalendarDate(parsed), '2026-03-29');
});

test('parseCalendarDateString ignores time portions instead of shifting by timezone', () => {
	const parsed = parseCalendarDateString('2026-03-29T23:45:00Z');
	assert.ok(parsed);
	assert.equal(formatCalendarDate(parsed), '2026-03-29');
});

test('parseCalendarDateString supports slash-delimited formats and rejects invalid dates', () => {
	const ymdSlash = parseCalendarDateString('2026/3/9');
	const mdySlash = parseCalendarDateString('03/29/2026');
	assert.ok(ymdSlash);
	assert.ok(mdySlash);
	assert.equal(formatCalendarDate(ymdSlash), '2026-03-09');
	assert.equal(formatCalendarDate(mdySlash), '2026-03-29');
	assert.equal(parseCalendarDateString('2026-02-30'), null);
	assert.equal(parseCalendarDateString('not-a-date'), null);
});

test('calendar-day arithmetic stays stable across DST boundaries', () => {
	const start = parseCalendarDateString('2026-03-28')!;
	const moved = addCalendarDays(start, 2);
	assert.equal(formatCalendarDate(moved), '2026-03-30');
	assert.equal(diffCalendarDays(start, moved), 2);
});

test('parseRawFrontmatterDate handles strings, numbers, and empty values safely', () => {
	const fromString = parseRawFrontmatterDate('2026-04-01T09:15:00');
	const fromDate = parseRawFrontmatterDate(new Date(2026, 2, 29, 18, 0, 0));
	assert.ok(fromString);
	assert.ok(fromDate);
	assert.equal(formatCalendarDate(fromString), '2026-04-01');
	assert.equal(parseRawFrontmatterDate(''), null);
	assert.equal(parseRawFrontmatterDate(false), null);
	assert.equal(formatCalendarDate(fromDate), '2026-03-29');
});

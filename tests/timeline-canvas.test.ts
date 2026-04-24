import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { getTimelineCanvasWidth } from '../src/timeline-canvas';

test('getTimelineCanvasWidth keeps day scale to a minimum ten-day canvas', () => {
	assert.equal(getTimelineCanvasWidth({
		frozenWidth: 200,
		tickCount: 3,
		timeScale: 'day',
		zoom: 1,
	}), '500px');
});

test('getTimelineCanvasWidth applies scale-specific fixed pixel sizing', () => {
	assert.equal(getTimelineCanvasWidth({
		frozenWidth: 175,
		tickCount: 20,
		timeScale: 'week',
		zoom: 1,
	}), '1375px');
	assert.equal(getTimelineCanvasWidth({
		frozenWidth: 175,
		tickCount: 2,
		timeScale: 'quarter',
		zoom: 1,
	}), '655px');
});

test('getTimelineCanvasWidth clamps sub-one zoom to one', () => {
	assert.equal(getTimelineCanvasWidth({
		frozenWidth: 100,
		tickCount: 1,
		timeScale: 'year',
		zoom: 0.25,
	}), '370px');
});

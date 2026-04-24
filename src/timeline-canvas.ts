import { getScaleZoomFactor, type TimeScale } from './timeline-axis';

export interface TimelineCanvasWidthInput {
	frozenWidth: number;
	tickCount: number;
	timeScale: TimeScale;
	zoom: number;
}

export function getTimelineCanvasWidth(input: TimelineCanvasWidthInput): string {
	const zoom = Math.max(input.zoom, 1);
	const tickCount = Math.max(0, input.tickCount);

	if (input.timeScale === 'day') {
		const dayPx = Math.min(30, 44 * zoom);
		return `${input.frozenWidth + Math.max(10, tickCount) * dayPx}px`;
	}

	if (input.timeScale === 'week') {
		return `${input.frozenWidth + Math.max(900, tickCount * 60 * zoom)}px`;
	}

	if (input.timeScale === 'month') {
		return `${input.frozenWidth + Math.max(900, tickCount * 55 * zoom)}px`;
	}

	if (input.timeScale === 'quarter') {
		const quarterPx = Math.min(200, 120 * zoom);
		return `${input.frozenWidth + Math.max(4, tickCount) * quarterPx}px`;
	}

	if (input.timeScale === 'year') {
		const yearPx = Math.min(150, 90 * zoom);
		return `${input.frozenWidth + Math.max(3, tickCount) * yearPx}px`;
	}

	return `calc(${input.frozenWidth}px + ${zoom * getScaleZoomFactor(input.timeScale) * 100}%)`;
}

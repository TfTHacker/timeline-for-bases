import { addCalendarDays, diffCalendarDays, localMidnight } from './timeline-date';

export interface MoveDragResolutionInput {
	origStart: Date;
	origEnd: Date;
	currentMouseDate: Date | null;
	startEdgeDate: Date | null;
	deltaDays: number;
	mouseAnchorDate: Date | null;
	mouseAnchorOffsetDays: number;
}

export interface ResizeDragResolutionInput {
	origStart: Date;
	origEnd: Date;
	currentMouseDate: Date | null;
	edgeDate: Date | null;
	deltaDays: number;
	minWidthDays: number;
}

export function resolveMovedRange(input: MoveDragResolutionInput): { start: Date; end: Date } {
	const spanDays = diffCalendarDays(input.origStart, input.origEnd);

	if (input.currentMouseDate && input.mouseAnchorDate) {
		const start = addCalendarDays(input.currentMouseDate, -input.mouseAnchorOffsetDays);
		return { start, end: addCalendarDays(start, spanDays) };
	}

	if (input.startEdgeDate) {
		const start = localMidnight(input.startEdgeDate);
		return { start, end: addCalendarDays(start, spanDays) };
	}

	return {
		start: addCalendarDays(input.origStart, input.deltaDays),
		end: addCalendarDays(input.origEnd, input.deltaDays),
	};
}

export function resolveResizeEndRange(input: ResizeDragResolutionInput): { start: Date; end: Date } {
	const start = new Date(input.origStart);
	const candidateEnd = input.currentMouseDate
		? localMidnight(input.currentMouseDate)
		: input.edgeDate
			? localMidnight(input.edgeDate)
			: addCalendarDays(input.origEnd, input.deltaDays);
	const minEnd = addCalendarDays(input.origStart, input.minWidthDays - 1);
	return {
		start,
		end: candidateEnd < minEnd ? minEnd : candidateEnd,
	};
}

export function resolveResizeStartRange(input: ResizeDragResolutionInput): { start: Date; end: Date } {
	const end = new Date(input.origEnd);
	const candidateStart = input.currentMouseDate
		? localMidnight(input.currentMouseDate)
		: input.edgeDate
			? localMidnight(input.edgeDate)
			: addCalendarDays(input.origStart, input.deltaDays);
	const maxStart = addCalendarDays(input.origEnd, -(input.minWidthDays - 1));
	return {
		start: candidateStart > maxStart ? maxStart : candidateStart,
		end,
	};
}

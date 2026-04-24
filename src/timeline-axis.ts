export type TimeScale = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type WeekStart = 'monday' | 'sunday';

/** Major ticks for the axis at the given scale. Always returns at least one tick. */
export function getTicksForScale(min: Date, max: Date, scale: string, weekStart: WeekStart = 'monday'): Date[] {
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

/** Minor grid ticks (subdivisions within major ticks) for week/month/quarter/year. */
export function getMinorGridTicks(min: Date, max: Date, scale: string, weekStart: WeekStart): Date[] {
	const ticks: Date[] = [];
	const current = new Date(min);

	if (scale === 'week') {
		current.setHours(0, 0, 0, 0);
		while (current <= max) {
			ticks.push(new Date(current));
			current.setDate(current.getDate() + 1);
		}
	} else if (scale === 'month') {
		const first = new Date(current);
		const day = current.getDay();
		const shift = weekStart === 'sunday' ? day : (day === 0 ? 6 : day - 1);
		first.setDate(current.getDate() - shift);
		first.setHours(0, 0, 0, 0);
		while (first <= max) {
			ticks.push(new Date(first));
			first.setDate(first.getDate() + 7);
		}
	} else if (scale === 'quarter' || scale === 'year') {
		current.setDate(1);
		current.setHours(0, 0, 0, 0);
		while (current <= max) {
			ticks.push(new Date(current));
			current.setMonth(current.getMonth() + 1);
		}
	}

	return ticks;
}

/** Thin out dense tick arrays so the axis stays legible at the given scale.
 *  day/week/month/year always show every tick; quarter may be reduced. */
export function reduceTicks(ticks: Date[], scale: string): Date[] {
	if (scale === 'day' || scale === 'week' || scale === 'month' || scale === 'year') return ticks;
	const maxVisible = 16;
	if (ticks.length <= maxVisible) return ticks;
	const step = Math.ceil(ticks.length / maxVisible);
	return ticks.filter((_, i) => i % step === 0 || i === ticks.length - 1);
}

/** Scale-specific zoom multiplier used when sizing the canvas. */
export function getScaleZoomFactor(scale: string): number {
	if (scale === 'day') return 2.4;
	if (scale === 'week') return 3.1;
	if (scale === 'month') return 1.15;
	if (scale === 'quarter') return 1;
	if (scale === 'year') return 0.9;
	return 1;
}

/** Snap a date to the start of its bucket at the given scale. */
export function snapStartToScale(date: Date, scale: string, weekStart: WeekStart = 'monday'): Date {
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

/** Snap a date to the end of its bucket at the given scale. */
export function snapEndToScale(date: Date, scale: string, weekStart: WeekStart = 'monday'): Date {
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

/** ISO 8601 week number — week containing the Thursday of its week. */
export function getIsoWeekNumber(date: Date): number {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export function formatTickLabel(date: Date, scale: string, formatter: Intl.DateTimeFormat): string {
	if (scale === 'week') return `W${getIsoWeekNumber(date)}`;
	if (scale === 'quarter') return `Q${Math.floor(date.getMonth() / 3) + 1}`;
	return formatter.format(date);
}

export function getAxisFormatter(min: Date, max: Date, scale?: string): Intl.DateTimeFormat {
	if (scale === 'day' || scale === 'week') {
		return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
	}
	if (scale === 'month') return new Intl.DateTimeFormat(undefined, { month: 'short' });
	if (scale === 'quarter' || scale === 'year') {
		return new Intl.DateTimeFormat(undefined, { year: 'numeric' });
	}

	const totalDays = Math.max(1, Math.round((max.getTime() - min.getTime()) / 86400000));
	if (totalDays > 365 * 2) return new Intl.DateTimeFormat(undefined, { year: 'numeric' });
	if (totalDays > 90) return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
	return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
}

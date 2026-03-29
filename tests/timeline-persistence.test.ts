import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	findScopedViewName,
	getScopedRecord,
	makeScopedViewKey,
} from '../src/timeline-persistence';

test('makeScopedViewKey builds a stable base/view identifier', () => {
	assert.equal(makeScopedViewKey('SPT.base', 'Short Project Tasks Timeline'), 'SPT.base::Short Project Tasks Timeline');
	assert.equal(makeScopedViewKey(null, 'Timeline'), null);
});

test('findScopedViewName finds the first matching view for a base file', () => {
	const records = {
		'Other.base::Timeline': 'week',
		'SPT.base::Short Project Tasks Timeline': 'day',
	};

	assert.equal(findScopedViewName(records, 'SPT.base'), 'Short Project Tasks Timeline');
	assert.equal(findScopedViewName(records, 'Missing.base'), null);
});

test('getScopedRecord returns the exact scoped value when both pieces are known', () => {
	const records = {
		'SPT.base::Short Project Tasks Timeline': { 'risk::High': true },
	};

	assert.deepEqual(getScopedRecord(records, 'SPT.base', 'Short Project Tasks Timeline'), { 'risk::High': true });
	assert.equal(getScopedRecord(records, 'SPT.base', 'Other Timeline'), null);
});

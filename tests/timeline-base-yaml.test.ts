import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyCustomKeysToYaml } from '../src/timeline-base-yaml';

const baseYaml = `views:
  - type: timeline
    name: Tasks
    startDate: note.start
    endDate: note.end
`;

test('appends custom string keys with single-quoted YAML when missing', () => {
	const { yaml, changed } = applyCustomKeysToYaml(baseYaml, {
		colorMap: 'High=#e03131;Low=#2f9e44',
	});
	assert.equal(changed, true);
	assert.match(yaml, /^ {4}colorMap: 'High=#e03131;Low=#2f9e44'$/m);
});

test('updates an existing custom key in place rather than appending a duplicate', () => {
	const yamlWithKey = baseYaml.trimEnd() + "\n    timeScale: 'week'\n";
	const { yaml, changed } = applyCustomKeysToYaml(yamlWithKey, { timeScale: 'day' });
	assert.equal(changed, true);
	assert.equal(yaml.match(/timeScale:/g)?.length, 1);
	assert.match(yaml, /^ {4}timeScale: 'day'$/m);
});

test('removes a custom key when its override is null or undefined', () => {
	const yamlWithKey = baseYaml.trimEnd() + "\n    colorMap: 'High=#e03131'\n";
	const { yaml, changed } = applyCustomKeysToYaml(yamlWithKey, { colorMap: null });
	assert.equal(changed, true);
	assert.doesNotMatch(yaml, /colorMap:/);
});

test('writes numeric and boolean overrides without quoting', () => {
	const { yaml, changed } = applyCustomKeysToYaml(baseYaml, {
		borderWidth: 3,
		showColors: true,
	});
	assert.equal(changed, true);
	assert.match(yaml, /^ {4}borderWidth: 3$/m);
	assert.match(yaml, /^ {4}showColors: true$/m);
});

test('escapes single quotes inside YAML string values', () => {
	const { yaml } = applyCustomKeysToYaml(baseYaml, { colorMap: "It's=ok" });
	assert.match(yaml, /^ {4}colorMap: 'It''s=ok'$/m);
});

test('re-quotes unquoted CUSTOM_STRING_KEYS already in the YAML', () => {
	const yamlUnquoted = baseYaml.trimEnd() + '\n    colorMap: High=#e03131;Low=#2f9e44\n';
	const { yaml, changed } = applyCustomKeysToYaml(yamlUnquoted, {});
	assert.equal(changed, true);
	assert.match(yaml, /^ {4}colorMap: 'High=#e03131;Low=#2f9e44'$/m);
});

test('returns changed=false when nothing needs to be modified', () => {
	const yamlClean = baseYaml.trimEnd() + "\n    colorMap: 'High=#e03131'\n";
	const { yaml, changed } = applyCustomKeysToYaml(yamlClean, {});
	assert.equal(changed, false);
	assert.equal(yaml, yamlClean);
});

test('ignores keys that are not in the custom-key allowlist', () => {
	const { yaml, changed } = applyCustomKeysToYaml(baseYaml, {
		// startDate is a Bases-declared option, not a custom key — must not be touched here.
		startDate: 'note.somethingElse',
	} as Record<string, unknown>);
	assert.equal(changed, false);
	assert.equal(yaml, baseYaml);
});

test('round-trips: writing then re-applying the same overrides is idempotent', () => {
	const overrides = { colorMap: 'High=#e03131', borderWidth: 2 };
	const first = applyCustomKeysToYaml(baseYaml, overrides);
	const second = applyCustomKeysToYaml(first.yaml, overrides);
	assert.equal(second.changed, false);
	assert.equal(second.yaml, first.yaml);
});

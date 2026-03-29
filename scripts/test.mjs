import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-tests-'));
const outDir = path.join(tempDir, 'dist');
const tsconfigPath = path.join(tempDir, 'tsconfig.json');

const tsconfig = {
	compilerOptions: {
		target: 'ES2020',
		module: 'NodeNext',
		moduleResolution: 'NodeNext',
		rootDir: repoRoot,
		outDir,
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
		typeRoots: [path.join(repoRoot, 'node_modules/@types')],
	},
	include: [
		path.join(repoRoot, 'src/timeline-date.ts'),
		path.join(repoRoot, 'src/timeline-drag.ts'),
		path.join(repoRoot, 'src/timeline-persistence.ts'),
		path.join(repoRoot, 'tests/**/*.test.ts'),
	],
};

fs.writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);

try {
	execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', tsconfigPath], {
		cwd: repoRoot,
		stdio: 'inherit',
	});

	const emittedTests = fs.readdirSync(path.join(outDir, 'tests'))
		.filter(name => name.endsWith('.test.js'))
		.map(name => path.join(outDir, 'tests', name));

	execFileSync(process.execPath, ['--test', ...emittedTests], {
		cwd: repoRoot,
		stdio: 'inherit',
	});
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}

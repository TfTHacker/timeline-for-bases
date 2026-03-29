import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const watchPaths = [
	path.join(projectRoot, 'src'),
	path.join(projectRoot, 'styles.css'),
	path.join(projectRoot, 'manifest.json'),
];

let timer = null;
let running = false;
let queued = false;

function runBuild() {
	if (running) {
		queued = true;
		return;
	}
	running = true;
	const child = spawn(process.execPath, ['esbuild.config.mjs'], { cwd: projectRoot, stdio: 'inherit' });
	child.on('exit', () => {
		if (child.exitCode === 0) {
			const sync = spawn(process.execPath, ['scripts/push-to-nexus.mjs'], { cwd: projectRoot, stdio: 'inherit' });
			sync.on('exit', () => {
				running = false;
				if (queued) {
					queued = false;
					runBuild();
				}
			});
			return;
		}
		running = false;
		if (queued) {
			queued = false;
			runBuild();
		}
	});
}

function scheduleBuild() {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		runBuild();
	}, 200);
}

console.log('Watching for changes...');
runBuild();

watchPaths.forEach((watchPath) => {
	if (!fs.existsSync(watchPath)) return;
	fs.watch(watchPath, { recursive: true }, () => {
		scheduleBuild();
	});
});

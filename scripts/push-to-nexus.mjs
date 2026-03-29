import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const nexusPluginDir = '/srv/shared_data/nexus/.obsidian/plugins/timeline-for-bases';

const filesToCopy = ['main.js', 'manifest.json', 'styles.css'];

function ensureDir(dirPath) {
	fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(filename) {
	const sourcePath = path.join(projectRoot, filename);
	const destPath = path.join(nexusPluginDir, filename);

	if (!fs.existsSync(sourcePath)) {
		throw new Error(`Missing build asset: ${sourcePath}`);
	}

	fs.copyFileSync(sourcePath, destPath);
}

function main() {
	ensureDir(nexusPluginDir);

	for (const filename of filesToCopy) {
		copyFile(filename);
	}

	console.log(`Pushed plugin assets to ${nexusPluginDir}`);
}

main();

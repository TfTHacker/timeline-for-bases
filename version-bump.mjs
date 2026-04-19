import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
	console.error("Error: npm_package_version not set. Run via 'npm version <patch|minor|major>'.");
	process.exit(1);
}

// npm version normally updates package.json before this script runs,
// but keep it in sync here too so the script is robust if reused directly.
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
packageJson.version = targetVersion;
writeFileSync("package.json", JSON.stringify(packageJson, null, "\t") + "\n");

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!versions[targetVersion]) {
	versions[targetVersion] = minAppVersion;
}
writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');

// update package-lock.json — keep lockfile version metadata aligned with package.json
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
lockfile.version = targetVersion;
if (lockfile.packages && lockfile.packages[""]) {
	lockfile.packages[""].version = targetVersion;
}
writeFileSync("package-lock.json", JSON.stringify(lockfile, null, "\t") + "\n");
import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
	console.error("Error: npm_package_version not set. Run via 'npm version <patch|minor|major>'.");
	process.exit(1);
}

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!versions[targetVersion]) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}

// update package-lock.json — npm version only updates package.json,
// the lockfile's top-level "version" field needs to match
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
lockfile.version = targetVersion;
// Also update the nested packages entry if it exists
if (lockfile.packages && lockfile.packages[""]) {
	lockfile.packages[""].version = targetVersion;
}
writeFileSync("package-lock.json", JSON.stringify(lockfile, null, "\t"));
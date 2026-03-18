#!/usr/bin/env bash
set -euo pipefail

current_version="$(node -p "require('./package.json').version")"
if [[ ! "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "Expected package.json version in x.y.z format, found $current_version."
	exit 1
fi

IFS='.' read -r major minor patch <<< "$current_version"
next_version="$major.$minor.$((patch + 1))"

if ! git diff --quiet; then
	echo "Working tree has unstaged changes. Commit or stash them before releasing."
	echo "Next step: run 'git status --short', then either commit the changes with 'git add -A && git commit -m \"...\"' or stash them with 'git stash push -u'."
	exit 1
fi

if ! git diff --cached --quiet; then
	echo "Working tree has staged but uncommitted changes. Commit or stash them before releasing."
	echo "Next step: run 'git status --short', then either commit the staged changes with 'git commit -m \"...\"' or unstage them with 'git restore --staged <file>'."
	exit 1
fi

echo "Releasing $next_version from current version $current_version."
npm version patch
git push origin main
git push origin --tags

echo "Release pushed successfully."

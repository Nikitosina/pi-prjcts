#!/bin/bash
# Usage: collect-arcanum.sh <pr-id> [output-dir]   (run from inside an Arcadia checkout)
# Pass a fresh output directory; existing snapshots are never overwritten.
set -euo pipefail
id=$1
[[ "$id" =~ ^[0-9]+$ ]] || { echo "PR id must be numeric" >&2; exit 1; }
D=${2:-${TMPDIR:-/tmp}/pr-review/$id/snap-$(date +%s)-$$}
[ ! -e "$D" ] || { echo "snapshot already exists: $D" >&2; exit 1; }
mkdir -p "$D/files"
ya tool arcanum pr get --id "$id" --json > "$D/pr.json"
ya tool arcanum pr active-diff --id "$id" --json > "$D/diff-set.json"
base=$(jq -r '.commit_ids.base' "$D/diff-set.json")
merge=$(jq -r '.commit_ids.merge' "$D/diff-set.json")
[[ -n "$base" && "$base" != null && -n "$merge" && "$merge" != null ]] || { echo "missing pinned revisions" >&2; exit 1; }
cd "$(arc root)"
arc diff "$base" "$merge" > "$D/diff.patch"
arc diff "$base" "$merge" --name-status | awk '$1 != "D" { print $2 }' | while read -r p; do
	mkdir -p "$D/files/$(dirname "$p")"
	arc show "$merge:$p" > "$D/files/$p"
done
[ -s "$D/diff.patch" ] || { echo "empty diff for PR $id" >&2; exit 1; }
chmod -R a-w "$D"
echo "$D"

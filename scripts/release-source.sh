#!/usr/bin/env bash
# Create and verify a deterministic source archive from one clean Git commit.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release-source.sh [--verify] [--output DIRECTORY] [REVISION]

Builds a deterministic gzip-compressed source archive from tracked content at
REVISION (default: HEAD), validates its exact inventory and MANIFEST.sha256
after unpacking, and prints the archive SHA-256. --verify performs the same
checks in temporary storage and retains no archive.
USAGE
}

die() {
  printf 'release-source: %s\n' "$*" >&2
  exit 1
}

verify_only=false
output_dir=''
revision='HEAD'

while (( $# )); do
  case "$1" in
    --verify)
      verify_only=true
      ;;
    --output)
      (( $# >= 2 )) || die '--output requires a directory'
      output_dir=$2
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      revision=$1
      ;;
  esac
  shift
done

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die 'run inside a Git worktree'
cd "$repo_root"

[[ -z $(git status --porcelain=v1 --untracked-files=all) ]] || die 'refusing dirty checkout'
commit=$(git rev-parse --verify --quiet "${revision}^{commit}") || die "not a commit: $revision"
short_commit=$(git rev-parse --short=12 "$commit")
prefix="codekeeper-source-${short_commit}/"

if ! $verify_only; then
  [[ -n $output_dir ]] || die 'pass --output DIRECTORY outside this checkout, or use --verify'
  requested_output=$output_dir
  [[ $requested_output = /* ]] || requested_output="$repo_root/$requested_output"
  case "$requested_output" in
    "$repo_root"|"$repo_root"/*) die 'output directory must be outside the checkout' ;;
  esac
  [[ -d $output_dir ]] || die "output directory does not exist: $output_dir"
  output_dir=$(cd "$output_dir" && pwd -P)
  case "$output_dir/" in
    "$repo_root"/*) die 'output directory must be outside the checkout' ;;
  esac
  archive="$output_dir/codekeeper-source-${commit}.tar.gz"
  [[ ! -e $archive ]] || die "refusing to overwrite existing archive: $archive"
else
  archive=$(mktemp "${TMPDIR:-/tmp}/codekeeper-source-${short_commit}.XXXXXX.tar.gz")
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/codekeeper-source-verify.XXXXXX")
cleanup() {
  rm -rf "$work_dir"
  $verify_only && rm -f "$archive"
}
trap cleanup EXIT

# git archive reads only committed tree objects; ignored and untracked debris has no path in it.
git archive --format=tar --prefix="$prefix" "$commit" | gzip -n > "$archive"

archive_inventory="$work_dir/archive-inventory"
expected_inventory="$work_dir/expected-inventory"
tar -tzf "$archive" | sed -e "s|^${prefix}||" -e '/^$/d' | awk 'substr($0, length($0), 1) != "/"' | sort > "$archive_inventory"
git ls-tree -r --name-only "$commit" | LC_ALL=C sort > "$expected_inventory"
cmp -s "$expected_inventory" "$archive_inventory" || {
  diff -u "$expected_inventory" "$archive_inventory" >&2 || true
  die 'archive inventory differs from the committed tree'
}

if grep -Eq '(^|/)(\.git|node_modules|\.claude|__MACOSX)(/|$)|(^|/)\.DS_Store$|\.(profraw|profdata|trace|xcresult)$|\.dSYM(/|$)' "$archive_inventory"; then
  die 'archive contains forbidden local or profiler debris'
fi

tar -xzf "$archive" -C "$work_dir"
archive_root="$work_dir/${prefix%/}"
[[ -f $archive_root/MANIFEST.sha256 ]] || die 'archive is missing MANIFEST.sha256'

manifest_paths_unsorted="$work_dir/manifest-paths-unsorted"
manifest_paths="$work_dir/manifest-paths"
release_inventory="$work_dir/release-inventory"
: > "$manifest_paths_unsorted"
while IFS= read -r manifest_line || [[ -n $manifest_line ]]; do
  [[ $manifest_line =~ ^[[:xdigit:]]{64}[[:space:]][[:space:]](.+)$ ]] || die 'MANIFEST.sha256 contains a malformed entry'
  manifest_path=${BASH_REMATCH[1]}
  [[ $manifest_path == ./* ]] && manifest_path=${manifest_path#./}
  [[ -n $manifest_path ]] || die 'MANIFEST.sha256 contains an empty path'
  case "$manifest_path" in
    /*|*'//'*) die "MANIFEST.sha256 contains an unsafe path: $manifest_path" ;;
  esac
  IFS=/ read -r -a manifest_components <<< "$manifest_path"
  for manifest_component in "${manifest_components[@]}"; do
    [[ -n $manifest_component && $manifest_component != . && $manifest_component != .. ]] || die "MANIFEST.sha256 contains an unsafe path: $manifest_path"
  done
  printf '%s\n' "$manifest_path" >> "$manifest_paths_unsorted"
done < "$archive_root/MANIFEST.sha256"
LC_ALL=C sort "$manifest_paths_unsorted" > "$manifest_paths"
duplicate_paths=$(LC_ALL=C uniq -d "$manifest_paths")
if [[ -n $duplicate_paths ]]; then
  die 'MANIFEST.sha256 contains duplicate paths'
fi
grep -vx 'MANIFEST.sha256' "$archive_inventory" > "$release_inventory"
cmp -s "$release_inventory" "$manifest_paths" || {
  diff -u "$release_inventory" "$manifest_paths" >&2 || true
  die 'MANIFEST.sha256 paths do not exactly cover the release inventory'
}
(
  cd "$archive_root"
  shasum -a 256 -c MANIFEST.sha256
)

printf 'verified source archive for %s (%s tracked files)\n' "$commit" "$(wc -l < "$expected_inventory" | tr -d ' ')"
if ! $verify_only; then
  printf '%s  %s\n' "$(shasum -a 256 "$archive" | awk '{print $1}')" "$archive"
fi

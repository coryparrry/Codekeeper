#!/usr/bin/env bash
# Create and verify a deterministic source archive from one clean Git commit.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release-source.sh [--verify|--verify-worktree] [--output DIRECTORY] [REVISION]

Builds a deterministic gzip-compressed source archive from tracked content at
REVISION (default: HEAD), validates its exact inventory and source manifests
after unpacking, and prints the archive SHA-256. --verify performs the same
checks in temporary storage and retains no archive. --verify-worktree checks
the complete non-ignored working-tree inventory and content without creating an archive.
USAGE
}

die() {
  printf 'release-source: %s\n' "$*" >&2
  exit 1
}

verify_only=false
verify_worktree=false
output_dir=''
revision='HEAD'

while (( $# )); do
  case "$1" in
    --verify)
      verify_only=true
      ;;
    --verify-worktree)
      verify_worktree=true
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
repo_root=$(cd "$repo_root" && pwd -P)
cd "$repo_root"

! $verify_only || ! $verify_worktree || die '--verify and --verify-worktree are mutually exclusive'

verify_release_tree() {
  local tree_root=$1
  local tree_inventory=$2
  node "$tree_root/scripts/verify-source-manifest.mjs" \
    --root "$tree_root" \
    --inventory "$tree_inventory"
}

if $verify_worktree; then
  work_dir=$(mktemp -d "${TMPDIR:-/tmp}/codekeeper-source-worktree.XXXXXX")
  trap 'rm -rf "$work_dir"' EXIT
  worktree_inventory="$work_dir/worktree-inventory"
  git ls-files --cached --others --exclude-standard | LC_ALL=C sort > "$worktree_inventory"
  if grep -Eq '(^|/)(\.git|node_modules|\.claude|__MACOSX)(/|$)|(^|/)\.DS_Store$|\.(profraw|profdata|trace|xcresult)$|\.dSYM(/|$)' "$worktree_inventory"; then
    die 'working tree contains forbidden local or profiler debris'
  fi
  verify_release_tree "$repo_root" "$worktree_inventory"
  commit=$(git rev-parse --verify HEAD)
  printf 'verified working tree for %s (%s source files)\n' "$commit" "$(wc -l < "$worktree_inventory" | tr -d ' ')"
  exit 0
fi

[[ -z $(git status --porcelain=v1 --untracked-files=all) ]] || die 'refusing dirty checkout'
commit=$(git rev-parse --verify --quiet "${revision}^{commit}") || die "not a commit: $revision"
short_commit=$(git rev-parse --short=12 "$commit")
prefix="codekeeper-source-${short_commit}/"

if ! $verify_only; then
  [[ -n $output_dir ]] || die 'pass --output DIRECTORY outside this checkout, or use --verify'
  [[ -d $output_dir ]] || die "output directory does not exist: $output_dir"
  output_dir=$(cd "$output_dir" && pwd -P)
  case "$output_dir/" in
    "$repo_root"/*) die 'output directory must be outside the checkout' ;;
  esac
  final_archive="$output_dir/codekeeper-source-${commit}.tar.gz"
  [[ ! -e $final_archive ]] || die "refusing to overwrite existing archive: $final_archive"
  archive=$(mktemp "$output_dir/.codekeeper-source-${short_commit}.XXXXXX.tar.gz")
else
  final_archive=''
  archive=$(mktemp "${TMPDIR:-/tmp}/codekeeper-source-${short_commit}.XXXXXX.tar.gz")
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/codekeeper-source-verify.XXXXXX")
cleanup() {
  rm -rf "$work_dir"
  [[ -z $archive ]] || rm -f "$archive"
}
trap cleanup EXIT

# git archive reads only committed tree objects; ignored and untracked debris has no path in it.
git archive --format=tar --prefix="$prefix" "$commit" | gzip -n > "$archive"

archive_inventory="$work_dir/archive-inventory"
expected_inventory="$work_dir/expected-inventory"
tar -tzf "$archive" | sed -e "s|^${prefix}||" -e '/^$/d' | awk 'substr($0, length($0), 1) != "/"' | LC_ALL=C sort > "$archive_inventory"
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
verify_release_tree "$archive_root" "$archive_inventory"

printf 'verified source archive for %s (%s tracked files)\n' "$commit" "$(wc -l < "$expected_inventory" | tr -d ' ')"
if ! $verify_only; then
  archive_sha256=$(shasum -a 256 "$archive" | awk '{print $1}')
  ln "$archive" "$final_archive" || die "could not publish archive without overwriting: $final_archive"
  rm -f "$archive"
  archive=''
  printf '%s  %s\n' "$archive_sha256" "$final_archive"
fi

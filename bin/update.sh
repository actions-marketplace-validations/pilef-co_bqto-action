#!/bin/sh
# Replace the vendored bqto binaries with those of a bqto release, checked against
# the release's checksums.txt. Without a tag, it vendors the release in checksums.txt
# again, so `git diff --exit-code bin/` afterwards proves bin/ matches that release.
# Usage: bin/update.sh [v0.11.0]
set -eu
cd "$(dirname "$0")"
tag=${1:-v$(sed -n 's/^[0-9a-f]\{64\}  bqto_\([0-9][0-9.]*\)_linux_amd64\.tar\.gz$/\1/p' checksums.txt)}
if ! printf '%s\n' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+'; then
	echo "error: $tag is not a release tag such as v0.11.0" >&2
	exit 1
fi
v=${tag#v}
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
gh release download "$tag" -R pilef-co/bqto -D "$dir" -p checksums.txt -p "bqto_${v}_linux_*.tar.gz"
for arch in amd64 arm64; do
	archive=bqto_${v}_linux_$arch.tar.gz
	want=$(awk -v f="$archive" '$2 == f { print $1 }' "$dir/checksums.txt")
	got=$( (sha256sum "$dir/$archive" 2>/dev/null || shasum -a 256 "$dir/$archive") | cut -d' ' -f1)
	if [ -z "$want" ] || [ "$want" != "$got" ]; then
		echo "error: $archive does not match the checksums.txt of $tag" >&2
		exit 1
	fi
	tar -xzf "$dir/$archive" -C "$dir" bqto
	mv "$dir/bqto" "bqto_linux_$arch"
	chmod 755 "bqto_linux_$arch"
done
cp "$dir/checksums.txt" .
echo "bin/ holds bqto $tag"

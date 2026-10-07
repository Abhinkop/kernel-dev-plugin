#!/bin/sh
# Run the test suite in a container: no Node.js needed on the host.
#
#   scripts/test.sh [all|unit|integration]
#
#   KWB_KERNEL_TREE  kernel tree for the integration tests (default ../linux-playground);
#                    mounted read-only, the tests work on a clone of it
#   KWB_E2E=1        also configure, build, boot and debug a kernel (several minutes)
#
# Results: coverage/index.html (coverage), test-results/*.md (coverage and
# UI performance summaries, test output).
set -eu
cd "$(dirname "$0")/.."
repo=$PWD
kernel=$(realpath "${KWB_KERNEL_TREE:-../linux-playground}")
image=kernel-workbench-test
docker build -q -t "$image" test/docker >/dev/null
kvm=
[ -e /dev/kvm ] && kvm="--device /dev/kvm"
# shellcheck disable=SC2086
exec docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e "KWB_E2E=${KWB_E2E:-}" -e "KWB_KERNEL_TREE=$kernel" \
	$kvm --group-add "$(stat -c %g /dev/kvm 2>/dev/null || echo 0)" \
	-v "$repo:$repo" -v "$kernel:$kernel:ro" -w "$repo" "$image" bash test/ci.sh "${1:-all}"

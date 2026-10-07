#!/usr/bin/env bash
# mkinitramfs.sh — pack a minimal initramfs around a static busybox.
#
# usage: mkinitramfs.sh ARCH BUSYBOX OUT.cpio.gz SRCTREE BUILD_DIR
#   ARCH      x86_64 | arm64 | riscv64 (checked against the busybox binary)
#   BUSYBOX   a statically linked busybox built for ARCH
#   SRCTREE   kernel source tree (for usr/gen_init_cpio.c)
#   BUILD_DIR kernel build dir (reuses its usr/gen_init_cpio if present)
#
# The archive is written with the kernel's own gen_init_cpio, so
# /dev/console exists without needing root for mknod.
set -euo pipefail

ARCH=$1 BUSYBOX=$2 OUT=$3 SRCTREE=$4 BUILD_DIR=$5

die() { echo "error: $*" >&2; exit 1; }

[ -f "$BUSYBOX" ] || die "busybox not found at $BUSYBOX (setting kernelDev.run.busybox)"

case $ARCH in
x86_64)  want='x86-64' ;;
arm64)   want='aarch64' ;;
riscv64) want='RISC-V' ;;
*) die "unsupported arch $ARCH" ;;
esac
if command -v file >/dev/null; then
	info=$(file -L "$BUSYBOX")
	echo "$info" | grep -q "$want" || die "$BUSYBOX is not a $ARCH binary: $info"
	echo "$info" | grep -q 'statically linked' || die "$BUSYBOX is not statically linked: $info"
fi

gen=$BUILD_DIR/usr/gen_init_cpio
if [ ! -x "$gen" ]; then
	gen=$BUILD_DIR/kernel-dev/gen_init_cpio
	mkdir -p "$(dirname "$gen")"
	${HOSTCC:-cc} -O2 -o "$gen" "$SRCTREE/usr/gen_init_cpio.c"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat > "$work/init" <<'EOF'
#!/bin/busybox sh
/bin/busybox --install -s
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null
mount -t tmpfs tmpfs /tmp
mount -t debugfs debugfs /sys/kernel/debug 2>/dev/null
mount -t tracefs tracefs /sys/kernel/tracing 2>/dev/null
echo
echo "Booted $(uname -r) on $(uname -m). Exit QEMU with Ctrl-A X."
echo
exec setsid cttyhack sh -l
EOF

cat > "$work/list" <<EOF
dir /dev 0755 0 0
nod /dev/console 0600 0 0 c 5 1
nod /dev/null 0666 0 0 c 1 3
dir /proc 0755 0 0
dir /sys 0755 0 0
dir /tmp 1777 0 0
dir /root 0700 0 0
dir /etc 0755 0 0
dir /bin 0755 0 0
dir /sbin 0755 0 0
dir /usr 0755 0 0
dir /usr/bin 0755 0 0
dir /usr/sbin 0755 0 0
file /bin/busybox $BUSYBOX 0755 0 0
slink /bin/sh busybox 0777 0 0
file /init $work/init 0755 0 0
EOF

mkdir -p "$(dirname "$OUT")"
"$gen" "$work/list" | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "==> initramfs: $OUT ($(du -h "$OUT" | cut -f1)) from $BUSYBOX"

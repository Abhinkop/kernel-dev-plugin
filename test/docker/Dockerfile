# Test environment: Node.js, the libraries VS Code (Electron) needs to run
# under Xvfb, and the kernel tools the integration tests exercise: GCC and
# LLVM (the kernel needs LLVM 17+, so Debian trixie), the arm64 and riscv64
# cross compilers, QEMU for all three architectures, gdb.
FROM node:22-trixie-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
	xvfb xauth libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libgtk-3-0t64 libgbm1 libasound2t64 libxss1 \
	libxkbfile1 libsecret-1-0 libxshmfence1 libdrm2 \
	ca-certificates unzip git git-email libmailtools-perl libnet-smtp-ssl-perl perl python3 \
	make gcc libc6-dev flex bison bc libelf-dev libssl-dev cpio file \
	clang lld llvm \
	gcc-aarch64-linux-gnu gcc-riscv64-linux-gnu \
	qemu-system-x86 qemu-system-arm qemu-system-misc opensbi \
	gdb gdb-multiarch busybox-static procps \
	&& (apt-get install -y --no-install-recommends qemu-system-riscv 2>/dev/null || true) \
	&& rm -rf /var/lib/apt/lists/*

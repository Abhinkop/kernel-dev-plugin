# Test environment: Node.js, the libraries VS Code (Electron) needs to run
# under Xvfb, and the kernel tools the integration tests exercise.
FROM node:22-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
	xvfb xauth libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgtk-3-0 libgbm1 libasound2 libxss1 \
	libxkbfile1 libsecret-1-0 libxshmfence1 libdrm2 \
	ca-certificates git git-email libmailtools-perl libnet-smtp-ssl-perl perl python3 \
	make gcc libc6-dev flex bison bc libelf-dev libssl-dev cpio file \
	qemu-system-x86 gdb busybox-static procps \
	&& rm -rf /var/lib/apt/lists/*

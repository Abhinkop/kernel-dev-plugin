// @ts-check
'use strict';

/**
 * Per-architecture facts. Everything arch-specific the extension needs
 * lives here, so adding an architecture means adding one entry.
 *
 * @typedef {Object} ArchInfo
 * @property {string} kernelArch     value of ARCH= for kbuild
 * @property {string} image          kernel image path, relative to the build dir
 * @property {string} gccPrefix      default CROSS_COMPILE for GCC builds when cross compiling
 * @property {string} clangTarget    --target= triple clangd needs for GCC compile databases
 * @property {string} qemu           qemu-system binary
 * @property {string[]} machine      machine/cpu args (TCG)
 * @property {string[]} machineKvm   machine/cpu args when KVM is usable
 * @property {string} console        console= for the kernel cmdline
 * @property {string} hostUname      `uname -m` value of a host that can run this natively
 * @property {string} vngArch        --arch value for virtme-ng
 */

/** @type {Record<string, ArchInfo>} */
const ARCHES = {
	x86_64: {
		kernelArch: 'x86_64',
		image: 'arch/x86/boot/bzImage',
		gccPrefix: 'x86_64-linux-gnu-',
		clangTarget: 'x86_64-linux-gnu',
		qemu: 'qemu-system-x86_64',
		machine: ['-M', 'q35', '-cpu', 'max'],
		machineKvm: ['-M', 'q35', '-cpu', 'host', '-enable-kvm'],
		console: 'ttyS0',
		hostUname: 'x86_64',
		vngArch: 'amd64',
	},
	arm64: {
		kernelArch: 'arm64',
		image: 'arch/arm64/boot/Image',
		gccPrefix: 'aarch64-linux-gnu-',
		clangTarget: 'aarch64-linux-gnu',
		qemu: 'qemu-system-aarch64',
		machine: ['-M', 'virt', '-cpu', 'max'],
		machineKvm: ['-M', 'virt', '-cpu', 'host', '-enable-kvm'],
		console: 'ttyAMA0',
		hostUname: 'aarch64',
		vngArch: 'arm64',
	},
	riscv64: {
		kernelArch: 'riscv',
		image: 'arch/riscv/boot/Image',
		gccPrefix: 'riscv64-linux-gnu-',
		clangTarget: 'riscv64-linux-gnu',
		qemu: 'qemu-system-riscv64',
		machine: ['-M', 'virt', '-cpu', 'rv64', '-bios', 'default'],
		machineKvm: ['-M', 'virt', '-cpu', 'host', '-enable-kvm', '-bios', 'default'],
		console: 'ttyS0',
		hostUname: 'riscv64',
		vngArch: 'riscv64',
	},
};

/** @param {string} arch */
function archInfo(arch) {
	const info = ARCHES[arch];
	if (!info)
		throw new Error(`Unsupported architecture "${arch}" (supported: ${Object.keys(ARCHES).join(', ')})`);
	return info;
}

/** @param {string} arch */
function isNative(arch) {
	return archInfo(arch).hostUname === require('os').machine();
}

module.exports = { ARCHES, archInfo, isNative };

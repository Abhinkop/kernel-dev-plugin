// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { archInfo } = require('./arch');

/** @typedef {import('./settings').Settings} Settings */

/**
 * One thing the workflow needs from the host.
 * @typedef {Object} Requirement
 * @property {'build'|'run'|'debug'|'check'|'git'} step
 * @property {string} what     binary name, header path, or a description
 * @property {string} [pkg]    Debian/Ubuntu package that provides it
 * @property {string} [hint]   what to do when there is no package
 * @property {() => boolean} present
 */

/**
 * Build tools for a set of make arguments (recorded at Configure, or the
 * ones the next Configure would use).
 * @param {string[]} makeArgs
 * @returns {Requirement[]}
 */
function buildRequirements(makeArgs) {
	const llvm = makeArgs.includes('LLVM=1');
	const cross = (makeArgs.find(a => a.startsWith('CROSS_COMPILE=')) || '').slice('CROSS_COMPILE='.length);
	/** @type {[string, string][]} */
	const bins = llvm
		? [['clang', 'clang'], ['ld.lld', 'lld'], ['llvm-ar', 'llvm'], ['llvm-nm', 'llvm'], ['llvm-objcopy', 'llvm']]
		: [[`${cross}gcc`, cross ? `gcc-${cross.replace(/-$/, '')}` : 'gcc'], [`${cross}ld`, cross ? `binutils-${cross.replace(/-$/, '')}` : 'binutils']];
	if (!llvm && cross)
		bins.push(['gcc', 'gcc']); // host programs (scripts/, tools/) are built with the host compiler
	bins.push(['make', 'make'], ['flex', 'flex'], ['bison', 'bison'], ['bc', 'bc'], ['perl', 'perl'], ['python3', 'python3']);
	if (makeArgs.some(a => /^CC=ccache /.test(a)))
		bins.push(['ccache', 'ccache']);
	return [
		...bins.map(([bin, pkg]) => ({ step: /** @type {const} */ ('build'), what: bin, pkg, present: () => onPath(bin) })),
		header('libelf/gelf.h', 'gelf.h', 'libelf-dev'),
		header('OpenSSL headers', 'openssl/ssl.h', 'libssl-dev'),
	];
}

/**
 * Everything Configure / Build / Run / Debug need for the current selection.
 * @param {Settings} s
 * @returns {Requirement[]}
 */
function requirements(s) {
	const arch = s.arch;
	const info = archInfo(arch);
	const makeArgs = (s.configured() || { makeArgs: s.makeArgsForConfigure() }).makeArgs;
	/** @type {Requirement[]} */
	const reqs = buildRequirements(makeArgs);

	if (s.get('run.mode', 'qemu') === 'virtme') {
		reqs.push({ step: 'run', what: 'vng', pkg: 'virtme-ng', present: () => onPath('vng') });
	} else {
		const qemuPkg = qemuPackage(arch);
		reqs.push({ step: 'run', what: info.qemu, pkg: qemuPkg, present: () => onPath(info.qemu) });
		const initramfs = s.get('run.initramfs', /** @type {Record<string,string>} */ ({}))[arch];
		if (initramfs)
			reqs.push({ step: 'run', what: `initramfs ${initramfs}`, hint: 'fix kernelDev.run.initramfs',
				present: () => fs.existsSync(path.resolve(s.root, initramfs)) });
	}

	const gdb = s.gdbPath();
	reqs.push({ step: 'debug', what: gdb, pkg: gdb === 'gdb-multiarch' ? 'gdb-multiarch' : gdb === 'gdb' ? 'gdb' : undefined,
		present: () => onPath(gdb) });

	// Kernel Git tab: always git; b4 fetches series for the Apply view.
	reqs.push({ step: 'git', what: 'git', pkg: 'git', present: () => onPath('git') });
	reqs.push({ step: 'git', what: 'b4', pkg: 'b4', present: () => onPath('b4') });
	// Optional patch checks, only when enabled.
	if (s.get('check.sparse', false))
		reqs.push({ step: 'check', what: 'sparse', pkg: 'sparse', present: () => onPath('sparse') });
	if (s.get('check.coccinelle', false)) {
		reqs.push({ step: 'check', what: 'spatch', pkg: 'coccinelle', present: () => onPath('spatch') });
		// Some of the kernel's .cocci scripts use OCaml; coccicheck stops without it.
		reqs.push({ step: 'check', what: 'ocamlopt', pkg: 'ocaml-nox', present: () => onPath('ocamlopt') || onPath('ocamlopt.opt') });
	}
	return reqs;
}

/** @type {Map<string, boolean>} */
const aptKnows = new Map();

/**
 * Whether apt has a package of that name (cached).
 * @param {string} pkg
 */
function aptHas(pkg) {
	if (!aptKnows.has(pkg)) {
		let has = false;
		try {
			has = /^Candidate: (?!\(none\))/m.test(execFileSync('apt-cache', ['policy', pkg], { encoding: 'utf8', timeout: 5000 }));
		} catch {}
		aptKnows.set(pkg, has);
	}
	return /** @type {boolean} */ (aptKnows.get(pkg));
}

/**
 * The Debian/Ubuntu package with an arch's QEMU. qemu-system-riscv64 was
 * in qemu-system-misc until QEMU 10 packaging split it out (Debian
 * trixie+, Ubuntu 25.10+).
 * @param {string} arch
 */
function qemuPackage(arch) {
	if (arch === 'riscv64')
		return aptHas('qemu-system-riscv') ? 'qemu-system-riscv' : 'qemu-system-misc';
	return /** @type {Record<string, string>} */ ({ x86_64: 'qemu-system-x86', arm64: 'qemu-system-arm' })[arch];
}

/**
 * @param {Settings} s
 * @returns {Requirement[]} the missing ones
 */
function missing(s) {
	return requirements(s).filter(r => !r.present());
}

/** @param {Requirement[]} reqs */
function installCommand(reqs) {
	const pkgs = [...new Set(reqs.map(r => r.pkg).filter(Boolean))];
	return pkgs.length && onPath('apt-get') ? `sudo apt-get install ${pkgs.join(' ')}` : '';
}

/**
 * "build: flex, bison · run: qemu-system-x86_64"
 * @param {Requirement[]} reqs
 */
function describe(reqs) {
	/** @type {Record<string, string[]>} */
	const by = {};
	for (const r of reqs)
		(by[r.step] ||= []).push(r.hint ? `${r.what} (${r.hint})` : r.what);
	return Object.entries(by).map(([step, list]) => `${step}: ${list.join(', ')}`).join(' · ');
}

/**
 * @param {string} label @param {string} rel @param {string} pkg
 * @returns {Requirement}
 */
function header(label, rel, pkg) {
	return {
		step: 'build', what: label, pkg,
		present: () => ['/usr/include', '/usr/local/include'].some(d => fs.existsSync(path.join(d, rel))),
	};
}

/** @param {string} bin */
function onPath(bin) {
	if (bin.includes('/'))
		return fs.existsSync(bin);
	return (process.env.PATH || '').split(path.delimiter).some(dir => {
		try {
			fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

module.exports = { requirements, buildRequirements, missing, installCommand, describe, onPath, qemuPackage, aptKnows };

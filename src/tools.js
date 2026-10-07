// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { archInfo, isNative } = require('./arch');

/** @typedef {import('./settings').Settings} Settings */

/**
 * One thing the workflow needs from the host.
 * @typedef {Object} Requirement
 * @property {'build'|'run'|'debug'} step
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

	if (s.get('run.mode', 'initramfs') === 'virtme') {
		reqs.push({ step: 'run', what: 'vng', pkg: 'virtme-ng', present: () => onPath('vng') });
	} else {
		const qemuPkg = /** @type {Record<string, string>} */ ({ x86_64: 'qemu-system-x86', arm64: 'qemu-system-arm', riscv64: 'qemu-system-misc' })[arch];
		reqs.push({ step: 'run', what: info.qemu, pkg: qemuPkg, present: () => onPath(info.qemu) });
		reqs.push({ step: 'run', what: 'gzip', pkg: 'gzip', present: () => onPath('gzip') });
		if (!s.get('run.initramfs', /** @type {Record<string,string>} */ ({}))[arch]) {
			const configured = s.get('run.busybox', /** @type {Record<string,string>} */ ({}))[arch];
			if (configured)
				reqs.push({ step: 'run', what: `busybox at ${configured}`, hint: 'fix kernelDev.run.busybox',
					present: () => fs.existsSync(path.resolve(s.root, configured)) });
			else if (isNative(arch))
				reqs.push({ step: 'run', what: 'busybox', pkg: 'busybox-static', present: () => onPath('busybox') });
			else
				reqs.push({ step: 'run', what: `static ${arch} busybox`, hint: `set its path in the Kernel panel (kernelDev.run.busybox)`,
					present: () => false });
		}
	}

	const gdb = s.gdbPath();
	reqs.push({ step: 'debug', what: gdb, pkg: gdb === 'gdb-multiarch' ? 'gdb-multiarch' : gdb === 'gdb' ? 'gdb' : undefined,
		present: () => onPath(gdb) });
	return reqs;
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

module.exports = { requirements, buildRequirements, missing, installCommand, describe, onPath };

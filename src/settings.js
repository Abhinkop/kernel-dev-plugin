// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ARCHES, archInfo, isNative } = require('./arch');

/**
 * Everything the user can set lives in VS Code settings (kernelDev.*), so it
 * is configured once at user level and works in every kernel tree. The
 * current selection (arch, variant, config) is per-workspace UI state, not a
 * file. Configure records the exact make arguments in the build directory;
 * Build, Run and Debug reuse them.
 */

/** @typedef {'debug'|'release'} Variant */

/**
 * What Configure recorded in <buildDir>/.kernel-dev.json.
 * @typedef {Object} Configured
 * @property {string} arch
 * @property {Variant} variant
 * @property {string} config      base config target or file
 * @property {string} buildDir    absolute
 * @property {string[]} makeArgs  O=, ARCH=, toolchain and user make args
 * @property {string} configuredAt
 */

const STATE_FILE = '.kernel-dev.json';

class Settings {
	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {vscode.WorkspaceFolder} folder
	 */
	constructor(context, folder) {
		this.context = context;
		this.folder = folder;
		this.root = folder.uri.fsPath;
		this._onDidChange = new vscode.EventEmitter();
		/** Fires when the selection or a kernelDev setting changes. */
		this.onDidChange = this._onDidChange.event;
		context.subscriptions.push(this._onDidChange, vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('kernelDev', folder.uri))
				this._onDidChange.fire(undefined);
		}));
	}

	/**
	 * @template T
	 * @param {string} key
	 * @param {T} fallback
	 * @returns {T extends string ? string : T extends number ? number : T extends boolean ? boolean : T}
	 */
	get(key, fallback) {
		const v = vscode.workspace.getConfiguration('kernelDev', this.folder.uri).get(key);
		return /** @type {any} */ (v === undefined || v === null ? fallback : v);
	}

	// --- selection ---------------------------------------------------------

	get arch() {
		const a = this.context.workspaceState.get('kernelDev.arch') || this.get('arch', '') ||
			Object.keys(ARCHES).find(isNative) || 'x86_64';
		return ARCHES[a] ? a : 'x86_64';
	}

	/** @returns {Variant} */
	get variant() {
		const v = this.context.workspaceState.get('kernelDev.variant') || this.get('variant', 'debug');
		return v === 'release' ? 'release' : 'debug';
	}

	/** Base config for the current arch: a make target or a .config path. */
	get config() {
		return this.context.workspaceState.get(`kernelDev.config.${this.arch}`) || this.get('configure.defconfig', 'defconfig');
	}

	/** @param {'arch'|'variant'|'config'} what @param {string} value */
	async select(what, value) {
		const key = what === 'config' ? `kernelDev.config.${this.arch}` : `kernelDev.${what}`;
		await this.context.workspaceState.update(key, value);
		this._onDidChange.fire(undefined);
	}

	// --- derived -----------------------------------------------------------

	/** @param {string} [arch] @param {Variant} [variant] */
	buildDir(arch = this.arch, variant = this.variant) {
		const tmpl = this.get('buildDirectory', 'build/${arch}/${variant}');
		return path.resolve(this.root, tmpl.replace(/\$\{arch\}/g, arch).replace(/\$\{variant\}/g, variant));
	}

	/**
	 * make arguments for a fresh Configure of the current selection.
	 * ARCH and CROSS_COMPILE are always explicit so the environment cannot
	 * change what gets built.
	 */
	makeArgsForConfigure() {
		const arch = this.arch;
		const info = archInfo(arch);
		const args = [`O=${this.buildDir()}`, `ARCH=${info.kernelArch}`];
		const ccache = this.get('make.ccache', false);
		if (this.get('toolchain', 'gcc') === 'llvm') {
			args.push('LLVM=1', 'CROSS_COMPILE=');
			if (ccache)
				args.push('CC=ccache clang');
		} else {
			const prefixes = this.get('crossCompile', /** @type {Record<string,string>} */ ({}));
			const prefix = prefixes[arch] ?? (isNative(arch) ? '' : info.gccPrefix);
			args.push(`CROSS_COMPILE=${prefix}`);
			if (ccache)
				args.push(`CC=ccache ${prefix}gcc`);
		}
		return args.concat(this.get('make.args', /** @type {string[]} */ ([])));
	}

	/**
	 * make arguments for building a configured tree: the toolchain part
	 * recorded at Configure (O=, ARCH=, LLVM=, CROSS_COMPILE=, CC=), which
	 * the .config was made with, and the extra arguments as they are set
	 * now, so a change such as W=1 applies to the next Build.
	 * @param {Configured} state
	 */
	makeArgs(state) {
		const base = [];
		for (const a of state.makeArgs) {
			if (!/^(O|ARCH|LLVM|CROSS_COMPILE|CC)=/.test(a))
				break;
			base.push(a);
		}
		return base.concat(this.get('make.args', /** @type {string[]} */ ([])));
	}

	jobs() {
		const j = this.get('make.jobs', 0);
		return `-j${j > 0 ? j : os.cpus().length}`;
	}

	// --- recorded configure state -------------------------------------------

	/** @returns {Configured | undefined} for the current selection */
	configured() {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.buildDir(), STATE_FILE), 'utf8'));
		} catch {
			return undefined;
		}
	}

	/** Forget what Configure recorded for the current selection. */
	clearConfigured() {
		fs.rmSync(path.join(this.buildDir(), STATE_FILE), { force: true });
		this._onDidChange.fire(undefined);
	}

	/** @param {Configured} state */
	saveConfigured(state) {
		fs.mkdirSync(state.buildDir, { recursive: true });
		fs.writeFileSync(path.join(state.buildDir, STATE_FILE), JSON.stringify(state, null, '\t') + '\n');
		this._onDidChange.fire(undefined);
	}

	gdbPath() {
		return this.get('debug.gdb', '') || (isNative(this.arch) ? 'gdb' : 'gdb-multiarch');
	}
}

module.exports = { Settings };

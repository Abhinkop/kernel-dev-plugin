// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { archInfo } = require('./arch');
const { runTask, sq } = require('./tasks');
const { updateCompileCommands } = require('./clangd');
const { buildRequirements, installCommand, describe } = require('./tools');

/** @typedef {import('./settings').Settings} Settings */
/** @typedef {import('./settings').Configured} Configured */

// What the guest needs to mount the build directory shared over 9p.
const SHARE_OPTIONS = {
	NET_9P: 'y', NET_9P_VIRTIO: 'y', '9P_FS': 'y', VIRTIO: 'y', VIRTIO_PCI: 'y', PCI: 'y', MODULES: 'y', MODULE_UNLOAD: 'y',
};

class Kbuild {
	/** @param {Settings} settings */
	constructor(settings) {
		this.s = settings;
		this.folder = settings.folder;
		this.root = settings.root;
	}

	/** @param {string[]} makeArgs @param {string[]} targets */
	make(makeArgs, ...targets) {
		return ['make', ...makeArgs, this.s.jobs(), ...targets].map(sq).join(' ');
	}

	/**
	 * Configure: base config -> fragments -> run-mode, variant and user
	 * options -> olddefconfig. Records the make arguments so Build uses the
	 * same ones. Afterwards lists options Kconfig refused.
	 */
	async configure() {
		const s = this.s;
		const arch = s.arch;
		const variant = s.variant;
		const config = s.config;
		const makeArgs = s.makeArgsForConfigure();
		if (!this.checkTools(makeArgs, arch))
			return 1;

		const out = s.buildDir();
		const dotconfig = path.join(out, '.config');
		const base = path.resolve(this.root, config);
		/** @type {Record<string, string>} */
		const options = {
			...(s.get('run.mode', 'qemu') === 'virtme'
				? s.get('configure.virtmeOptions', {})
				: s.get('configure.qemuOptions', {})),
			...(s.get('run.shareBuildDir', false) ? SHARE_OPTIONS : {}),
			...(variant === 'debug' ? s.get('configure.debugOptions', {}) : s.get('configure.releaseOptions', {})),
			...s.get('configure.options', {}),
		};
		const fragments = s.get('configure.fragments', /** @type {string[]} */ ([]));

		const script = [
			'set -e',
			`mkdir -p ${sq(out)}`,
			`echo "==> ${arch} ${variant}: ${config}"`,
			fs.existsSync(base) && fs.statSync(base).isFile()
				? `cp ${sq(base)} ${sq(dotconfig)}`
				: this.make(makeArgs, ...config.split(/\s+/).filter(Boolean)),
		];
		if (fragments.length)
			script.push(
				'echo "==> merging fragments"',
				`ARCH=${sq(archInfo(arch).kernelArch)} scripts/kconfig/merge_config.sh -m -O ${sq(out)} ${sq(dotconfig)} ` +
					fragments.map(f => sq(path.resolve(this.root, f))).join(' '),
			);
		const optionArgs = scriptsConfigArgs(options);
		if (optionArgs.length)
			script.push(
				`echo "==> applying ${Object.keys(options).length} options"`,
				`scripts/config --file ${sq(dotconfig)} ${optionArgs.map(sq).join(' ')}`,
			);
		script.push(
			this.make(makeArgs, 'olddefconfig'),
			// Kconfig silently drops options with unmet dependencies; say so.
			...Object.entries(options).map(([name, want]) => {
				const w = want === 'n' ? 'n|undef' : want === 'y' || want === 'm' ? want : '.*';
				return `s=$(scripts/config --file ${sq(dotconfig)} -s ${sq(name)}); ` +
					`echo "$s" | grep -Eqx '${w}' || echo "warning: CONFIG_${name}=${want} requested, got $s (dependency not met?)"`;
			}),
			`echo "==> configured ${dotconfig}"`,
		);

		const code = await runTask(this.folder, `Configure ${arch} ${variant}`, 'bash', ['-c', script.join('\n')]);
		if (code === 0)
			s.saveConfigured({ arch, variant, config, buildDir: out, makeArgs, configuredAt: new Date().toISOString() });
		return code;
	}

	/**
	 * Build with the arguments recorded by Configure (configuring first if
	 * needed), then refresh compile_commands.json for clangd.
	 */
	async build() {
		let state = this.s.configured();
		if (!state) {
			if (await this.configure() !== 0)
				return 1;
			state = this.s.configured();
			if (!state)
				return 1;
		}
		if (!this.checkTools(state.makeArgs, state.arch))
			return 1;
		const script = [
			'set -e',
			this.make(state.makeArgs),
			this.make(state.makeArgs, 'compile_commands.json'),
			`echo "==> ${state.arch} ${state.variant} built"`,
		].join('\n');
		const code = await runTask(this.folder, `Build ${state.arch} ${state.variant}`, 'bash', ['-c', script], {
			problemMatcher: ['$gcc'],
		});
		if (code === 0)
			await updateCompileCommands(this.root, state);
		return code;
	}

	async clean() {
		const state = this.s.configured();
		if (!state)
			return 0;
		return runTask(this.folder, `Clean ${state.arch} ${state.variant}`, 'bash', ['-c', this.make(state.makeArgs, 'clean')]);
	}

	/** Full clean: `make mrproper` on the selected build (removes .config and all build output). */
	async mrproper() {
		const s = this.s;
		const makeArgs = (s.configured() || { makeArgs: s.makeArgsForConfigure() }).makeArgs;
		const code = await runTask(this.folder, `Full clean ${s.arch} ${s.variant}`, 'bash', ['-c', this.make(makeArgs, 'mrproper')]);
		if (code === 0)
			s.clearConfigured();
		return code;
	}

	/** make modules with the recorded arguments. */
	async buildModules() {
		const state = this.s.configured();
		if (!state) {
			vscode.window.showWarningMessage('Kernel: run Configure first.');
			return 1;
		}
		return runTask(this.folder, `Modules ${state.arch} ${state.variant}`, 'bash', ['-c', this.make(state.makeArgs, 'modules')],
			{ problemMatcher: ['$gcc'] });
	}

	/**
	 * Build one directory of the tree, built-in objects and modules
	 * (make <dir>/).
	 * @param {vscode.Uri | undefined} uri a folder, or a file whose folder is built
	 */
	async buildDirectory(uri) {
		const state = this.s.configured();
		if (!state) {
			vscode.window.showWarningMessage('Kernel: run Configure first.');
			return 1;
		}
		const target = uri || vscode.window.activeTextEditor?.document.uri;
		if (!target)
			return 1;
		let dir = target.fsPath;
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
			dir = path.dirname(dir);
		const rel = path.relative(this.root, dir);
		if (!rel || rel.startsWith('..')) {
			vscode.window.showWarningMessage('Kernel: pick a directory inside the kernel tree.');
			return 1;
		}
		// make <dir>/ compiles the directory but links no modules (that is
		// modpost's job), so link each module it compiled: Kbuild leaves a
		// <name>.mod next to each module's objects.
		const script = [
			'set -e',
			this.make(state.makeArgs, `${rel}/`),
			`mods=$(cd ${sq(state.buildDir)} && find ${sq(rel)} -name '*.mod' 2>/dev/null | sed 's/[.]mod$/.ko/' || true)`,
			`if [ -n "$mods" ]; then ${this.make(state.makeArgs)} $mods; echo "==> modules:"; echo "$mods"; fi`,
		].join('\n');
		return runTask(this.folder, `Build ${rel}/`, 'bash', ['-c', script], { problemMatcher: ['$gcc'] });
	}

	/** menuconfig / nconfig on the configured build, in a real terminal. @param {string} tool */
	async interactiveConfig(tool) {
		const state = this.s.configured();
		if (!state)
			return vscode.window.showWarningMessage('Kernel: run Configure first.');
		const term = vscode.window.createTerminal({
			name: `${tool} ${state.arch} ${state.variant}`,
			cwd: this.root,
			shellPath: 'bash',
			// A clean exit closes the terminal; a failure stays to be read.
			shellArgs: ['-c', `${this.make(state.makeArgs, tool)} || { echo; read -n1 -p "${tool} failed. Press a key to close."; exit 1; }`],
		});
		term.show();
	}

	/**
	 * Compile just one file (Ctrl+F7). '.i' / '.s' open the result.
	 * @param {vscode.Uri} file
	 * @param {'.o'|'.i'|'.s'} kind
	 */
	async compileFile(file, kind) {
		const state = this.s.configured();
		if (!state) {
			vscode.window.showWarningMessage('Kernel: run Configure first.');
			return 1;
		}
		const rel = path.relative(this.root, file.fsPath);
		if (rel.startsWith('..') || !/\.[cS]$/.test(rel)) {
			vscode.window.showWarningMessage('Kernel: open a .c or .S file inside the kernel tree.');
			return 1;
		}
		const target = rel.replace(/\.[cS]$/, kind);
		const code = await runTask(this.folder, `Compile ${path.basename(target)}`, 'bash',
			['-c', this.make(state.makeArgs, target)], { problemMatcher: ['$gcc'] });
		if (code === 0 && kind !== '.o') {
			const outFile = path.join(state.buildDir, target);
			if (fs.existsSync(outFile))
				await vscode.window.showTextDocument(vscode.Uri.file(outFile), { preview: true, viewColumn: vscode.ViewColumn.Beside });
		}
		return code;
	}

	/**
	 * Fail early, naming the packages to install, if build tools are missing.
	 * @param {string[]} makeArgs @param {string} arch
	 */
	checkTools(makeArgs, arch) {
		const missing = buildRequirements(makeArgs).filter(r => !r.present());
		if (!missing.length)
			return true;
		const cmd = installCommand(missing);
		vscode.window.showErrorMessage(`Kernel: cannot build ${arch}, missing ${describe(missing)}.` +
			(cmd ? ` Install with: ${cmd}` : ''));
		return false;
	}

	/** @param {Configured} state */
	image(state) {
		return path.join(state.buildDir, archInfo(state.arch).image);
	}

	/** @param {Configured} state */
	vmlinux(state) {
		return path.join(state.buildDir, 'vmlinux');
	}
}

/**
 * @param {Record<string, string>} opts  name (no CONFIG_) -> y/n/m/number/string
 * @returns {string[]} scripts/config arguments
 */
function scriptsConfigArgs(opts) {
	const args = [];
	for (const [name, value] of Object.entries(opts)) {
		if (value === 'y') args.push('-e', name);
		else if (value === 'n') args.push('-d', name);
		else if (value === 'm') args.push('-m', name);
		else if (/^-?(0x)?[0-9a-fA-F]+$/.test(value)) args.push('--set-val', name, value);
		else args.push('--set-str', name, value.replace(/^"|"$/g, ''));
	}
	return args;
}

module.exports = { Kbuild };

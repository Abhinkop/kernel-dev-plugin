// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { archInfo, isNative } = require('./arch');
const { runTask, sq } = require('./tasks');

/** @typedef {import('./settings').Settings} Settings */
/** @typedef {import('./settings').Configured} Configured */
/** @typedef {import('./kbuild').Kbuild} Kbuild */

const SESSION_MARKER = '__kernelDevVm';

class Runner {
	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {Settings} settings
	 * @param {Kbuild} kbuild
	 */
	constructor(context, settings, kbuild) {
		this.context = context;
		this.s = settings;
		this.kbuild = kbuild;
		/** @type {vscode.Terminal | undefined} */
		this.vm = undefined;
		context.subscriptions.push(
			vscode.window.onDidCloseTerminal(t => {
				if (t === this.vm)
					this.vm = undefined;
			}),
			vscode.debug.onDidTerminateDebugSession(session => {
				if (session.configuration[SESSION_MARKER] && this.s.get('debug.stopVmWhenDebuggingEnds', true))
					this.stop();
			}),
		);
	}

	get running() {
		return !!this.vm && this.vm.exitStatus === undefined;
	}

	stop() {
		const vm = this.vm;
		this.vm = undefined;
		vm?.dispose();
	}

	/** Ctrl+F5: build if needed, then boot without a debugger. */
	async run() {
		const state = await this.prepare();
		if (state)
			this.boot(state, false);
	}

	/**
	 * F5: build if needed, boot halted with a gdbstub, run to a symbol on a
	 * hardware breakpoint, then attach the IDE debugger there.
	 *
	 * At reset the MMU is off (and an x86 bzImage has not decompressed the
	 * kernel yet), so software breakpoints set by the IDE would fail or be
	 * overwritten. Once at start_kernel they stick.
	 */
	async debug() {
		if (this.s.variant === 'release') {
			const pick = await vscode.window.showWarningMessage(
				'Kernel: the Release build has no debug info. Switch to Debug?', 'Switch to Debug', 'Debug Anyway');
			if (!pick)
				return;
			if (pick === 'Switch to Debug')
				await this.s.select('variant', 'debug');
		}
		const flavor = this.debuggerFlavor();
		if (!await this.checkDebugger(flavor))
			return;
		const state = await this.prepare();
		if (!state)
			return;

		const port = this.s.get('debug.port', 1234);
		const breakAt = this.s.get('debug.breakAt', 'start_kernel');
		this.boot(state, true);

		const ok = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Kernel: booting ${state.arch} ${state.variant}`,
			cancellable: true,
		}, async (progress, cancel) => {
			progress.report({ message: 'waiting for gdbstub…' });
			if (!await waitForPort(port, 30000, cancel)) {
				if (!cancel.isCancellationRequested)
					vscode.window.showErrorMessage(`Kernel: QEMU gdbstub did not come up on port ${port}; see the VM terminal.`);
				return false;
			}
			if (!breakAt)
				return true;
			progress.report({ message: `running to ${breakAt}…` });
			try {
				await runToSymbol(this.s.gdbPath(), this.kbuild.vmlinux(state), port, breakAt, cancel);
				return true;
			} catch (e) {
				if (!cancel.isCancellationRequested)
					vscode.window.showErrorMessage(`Kernel: could not reach ${breakAt}: ${/** @type {Error} */ (e).message}`);
				return false;
			}
		});
		if (!ok) {
			this.stop();
			return;
		}
		await vscode.debug.startDebugging(this.s.folder, this.debugConfiguration(state, flavor, port));
	}

	/**
	 * Configured + built (when kernelDev.buildBeforeRun) + rootfs ready.
	 * @returns {Promise<Configured | undefined>}
	 */
	async prepare() {
		if (this.s.get('buildBeforeRun', true)) {
			if (await this.kbuild.build() !== 0) {
				vscode.window.showErrorMessage('Kernel: build failed; see the Build terminal.');
				return undefined;
			}
		}
		const state = this.s.configured();
		if (!state || !fs.existsSync(this.kbuild.image(state))) {
			vscode.window.showErrorMessage(`Kernel: no ${this.s.arch} ${this.s.variant} kernel image. Build first.`);
			return undefined;
		}
		if (this.s.get('run.mode', 'initramfs') === 'initramfs' && !await this.ensureInitramfs(state))
			return undefined;
		return state;
	}

	/** @param {Configured} state */
	initramfsPath(state) {
		const custom = this.s.get('run.initramfs', /** @type {Record<string,string>} */ ({}))[state.arch];
		return custom ? path.resolve(this.s.root, custom) : path.join(state.buildDir, 'kernel-dev', 'initramfs.cpio.gz');
	}

	/**
	 * Use kernelDev.run.initramfs.<arch> if set; otherwise pack one around
	 * kernelDev.run.busybox.<arch> (default for the host arch: busybox on
	 * PATH). Repacked when the busybox changes.
	 * @param {Configured} state
	 */
	async ensureInitramfs(state) {
		const out = this.initramfsPath(state);
		const custom = this.s.get('run.initramfs', /** @type {Record<string,string>} */ ({}))[state.arch];
		if (custom) {
			if (fs.existsSync(out))
				return true;
			vscode.window.showErrorMessage(`Kernel: initramfs ${out} (kernelDev.run.initramfs.${state.arch}) does not exist.`);
			return false;
		}

		const configured = this.s.get('run.busybox', /** @type {Record<string,string>} */ ({}))[state.arch];
		const busybox = configured ? path.resolve(this.s.root, configured) : (isNative(state.arch) ? which('busybox') : undefined);
		if (!busybox) {
			const pick = await vscode.window.showErrorMessage(
				`Kernel: to boot ${state.arch}, set the path to a static ${state.arch} busybox (kernelDev.run.busybox).`, 'Open Setting');
			if (pick)
				await vscode.commands.executeCommand('workbench.action.openSettings', 'kernelDev.run.busybox');
			return false;
		}

		const stamp = `${out}.source`;
		const upToDate = fs.existsSync(out) && readOr(stamp) === busybox &&
			fs.statSync(out).mtimeMs >= fs.statSync(busybox).mtimeMs;
		if (upToDate)
			return true;
		const script = path.join(this.context.extensionPath, 'scripts', 'mkinitramfs.sh');
		const code = await runTask(this.s.folder, `Initramfs ${state.arch}`, 'bash',
			[script, state.arch, busybox, out, this.s.root, state.buildDir]);
		if (code === 0)
			fs.writeFileSync(stamp, busybox);
		return code === 0;
	}

	/** @param {string} arch */
	useKvm(arch) {
		const kvm = this.s.get('run.kvm', 'auto');
		if (kvm === 'on')
			return true;
		if (kvm === 'off' || !isNative(arch))
			return false;
		try {
			fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * @param {Configured} state
	 * @param {boolean} debug
	 * @returns {{ cmd: string, args: string[] }}
	 */
	vmCommand(state, debug) {
		const info = archInfo(state.arch);
		const port = this.s.get('debug.port', 1234);
		const extraCmdline = this.s.get('run.cmdline', '');
		const qemuArgs = this.s.get('run.qemuArgs', /** @type {string[]} */ ([]));
		const memory = this.s.get('run.memory', '2G');
		const smp = String(this.s.get('run.smp', 2));
		const gdbArgs = debug ? ['-gdb', `tcp:localhost:${port}`, '-S'] : [];
		const cmdline = [debug ? 'nokaslr' : '', extraCmdline].filter(Boolean).join(' ');

		if (this.s.get('run.mode', 'initramfs') === 'virtme') {
			const args = ['--run', this.kbuild.image(state), '--arch', info.vngArch, '--memory', memory, '--cpus', smp];
			if (cmdline)
				args.push('--append', cmdline);
			const qemuOpts = [...qemuArgs, ...gdbArgs];
			if (qemuOpts.length)
				args.push('--qemu-opts', qemuOpts.join(' '));
			return { cmd: 'vng', args: args.concat(this.s.get('run.virtmeArgs', /** @type {string[]} */ ([]))) };
		}

		return {
			cmd: info.qemu,
			args: [
				...(this.useKvm(state.arch) ? info.machineKvm : info.machine),
				'-smp', smp,
				'-m', memory,
				'-kernel', this.kbuild.image(state),
				'-initrd', this.initramfsPath(state),
				'-append', [`console=${info.console}`, 'rdinit=/init', cmdline].filter(Boolean).join(' '),
				'-nographic',
				'-no-reboot',
				...qemuArgs,
				...gdbArgs,
			],
		};
	}

	/** @param {Configured} state @param {boolean} debug */
	boot(state, debug) {
		this.stop();
		const { cmd, args } = this.vmCommand(state, debug);
		this.vm = vscode.window.createTerminal({
			name: `${debug ? 'Debug' : 'Run'} ${state.arch} ${state.variant}`,
			cwd: this.s.root,
			shellPath: cmd,
			shellArgs: args,
			message: `\x1b[2m$ ${[cmd, ...args].map(sq).join(' ')}\r\n(Ctrl-A X quits QEMU)\x1b[0m\r\n`,
			iconPath: new vscode.ThemeIcon(debug ? 'debug-alt' : 'vm-running'),
		});
		this.vm.show();
	}

	/** @returns {'cppdbg'|'gdb'|'lldb'} */
	debuggerFlavor() {
		const want = this.s.get('debug.debugger', 'auto');
		if (want === 'cppdbg' || want === 'gdb' || want === 'lldb')
			return want;
		if (vscode.extensions.getExtension('ms-vscode.cpptools'))
			return 'cppdbg';
		if (vscode.extensions.getExtension('webfreak.debug'))
			return 'gdb';
		if (vscode.extensions.getExtension('vadimcn.vscode-lldb'))
			return 'lldb';
		return 'cppdbg';
	}

	/** @param {'cppdbg'|'gdb'|'lldb'} flavor */
	async checkDebugger(flavor) {
		const ext = { cppdbg: 'ms-vscode.cpptools', gdb: 'webfreak.debug', lldb: 'vadimcn.vscode-lldb' }[flavor];
		if (vscode.extensions.getExtension(ext))
			return true;
		const pick = await vscode.window.showErrorMessage(
			`Kernel: debugging needs a gdb front end. Install ${ext}? (In VSCodium: webfreak.debug.)`, 'Install');
		if (pick)
			await vscode.commands.executeCommand('workbench.extensions.installExtension', ext);
		return false;
	}

	/**
	 * In-memory debug configuration; nothing is written to launch.json.
	 * @param {Configured} state
	 * @param {'cppdbg'|'gdb'|'lldb'} flavor
	 * @param {number} port
	 * @returns {vscode.DebugConfiguration}
	 */
	debugConfiguration(state, flavor, port) {
		const root = this.s.root;
		const vmlinux = this.kbuild.vmlinux(state);
		const gdb = this.s.gdbPath();
		const target = `localhost:${port}`;
		const name = `Kernel ${state.arch} ${state.variant}`;
		const stopOnEntry = this.s.get('debug.stopOnEntry', false);
		// vmlinux-gdb.py (lx-* commands) lives in the build dir and symlinks
		// into scripts/gdb in the source tree; both must be on the safe path.
		const gdbInit = [
			`add-auto-load-safe-path ${state.buildDir}`,
			`add-auto-load-safe-path ${path.join(root, 'scripts', 'gdb')}`,
			'set print pretty on',
			...this.s.get('debug.gdbCommands', /** @type {string[]} */ ([])),
		];
		switch (flavor) {
		case 'gdb':
			return {
				type: 'gdb', request: 'attach', name, executable: vmlinux, target, remote: true, cwd: root,
				gdbpath: gdb, autorun: gdbInit, valuesFormatting: 'prettyPrinters', stopAtConnect: stopOnEntry,
				[SESSION_MARKER]: true,
			};
		case 'lldb':
			return {
				type: 'lldb', request: 'custom', name,
				targetCreateCommands: [`target create ${vmlinux}`], processCreateCommands: [`gdb-remote ${target}`],
				[SESSION_MARKER]: true,
			};
		default:
			return {
				type: 'cppdbg', request: 'launch', name, program: vmlinux, cwd: root, MIMode: 'gdb',
				miDebuggerPath: gdb, miDebuggerServerAddress: target, stopAtConnect: stopOnEntry,
				setupCommands: [
					{ text: '-enable-pretty-printing', ignoreFailures: true },
					...gdbInit.map(text => ({ text, ignoreFailures: true })),
				],
				[SESSION_MARKER]: true,
			};
		}
	}
}

/** @param {string} bin */
function which(bin) {
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		const p = path.join(dir, bin);
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return fs.realpathSync(p);
		} catch {}
	}
	return undefined;
}

/** @param {string} file */
function readOr(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

/**
 * @param {number} port
 * @param {number} timeoutMs
 * @param {vscode.CancellationToken} cancel
 */
async function waitForPort(port, timeoutMs, cancel) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !cancel.isCancellationRequested) {
		const up = await new Promise(resolve => {
			const sock = net.connect(port, '127.0.0.1');
			sock.once('connect', () => { sock.destroy(); resolve(true); });
			sock.once('error', () => resolve(false));
		});
		if (up)
			return true;
		await new Promise(r => setTimeout(r, 200));
	}
	return false;
}

/**
 * Throwaway gdb: hardware-break at `symbol`, continue, then `disconnect`
 * (not detach) so QEMU stays halted there for the IDE debugger.
 * @param {string} gdb
 * @param {string} vmlinux
 * @param {number} port
 * @param {string} symbol
 * @param {vscode.CancellationToken} cancel
 */
function runToSymbol(gdb, vmlinux, port, symbol, cancel) {
	const script = path.join(__dirname, '..', 'scripts', 'run-to.py');
	return new Promise((resolve, reject) => {
		const child = execFile(gdb, ['-q', '-nx', '-batch', '-ex', `file ${vmlinux}`, '-x', script], {
			env: { ...process.env, KD_TARGET: `localhost:${port}`, KD_SYMBOL: symbol },
			timeout: 10 * 60 * 1000,
			maxBuffer: 16 << 20,
		}, (err, stdout, stderr) => {
			if (/^kernel-dev: stopped at \S+ \(pc=/m.test(stdout))
				resolve(undefined);
			else if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT')
				reject(new Error(`${gdb} not found (install gdb-multiarch, or set kernelDev.debug.gdb)`));
			else
				reject(new Error((stderr || stdout || String(err)).trim().split('\n').slice(-3).join(' ')));
		});
		cancel.onCancellationRequested(() => child.kill());
	});
}

module.exports = { Runner };

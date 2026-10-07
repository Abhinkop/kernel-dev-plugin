'use strict';

// End to end for the cross architectures: configure, build, boot, decode
// the panic of a kernel with no root file system, and hand a guest halted
// at start_kernel to the debugger. Only with KWB_E2E=1; KWB_CROSS picks
// the architectures (default "arm64 riscv64").

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');
const { api, answer, git } = require('./helpers');
const { time, until } = require('./perf');

const e2e = process.env.KWB_E2E === '1' ? describe : describe.skip;
const ARCHES = (process.env.KWB_CROSS || 'arm64 riscv64').split(/\s+/).filter(Boolean);

e2e('End to end, cross architectures', function () {
	this.timeout(60 * 60 * 1000);
	let x;
	const cfg = () => vscode.workspace.getConfiguration('kernelDev', vscode.workspace.workspaceFolders[0].uri);

	before(async () => {
		x = await api();
		git('checkout', '-q', '-B', 'kwb-e2e-cross', 'kwb-test-base');
		await cfg().update('toolchain', 'gcc', vscode.ConfigurationTarget.Workspace);
		await cfg().update('run.kvm', 'off', vscode.ConfigurationTarget.Workspace);
		await cfg().update('run.initramfs', {}, vscode.ConfigurationTarget.Workspace);
		await cfg().update('buildBeforeRun', false, vscode.ConfigurationTarget.Workspace);
	});

	for (const arch of ARCHES) {
		describe(arch, () => {
			before(async () => {
				await x.settings.select('arch', arch);
				await x.settings.select('variant', 'debug');
				await x.settings.select('config', 'defconfig');
			});

			it('configures and builds with the cross compiler', async () => {
				assert.strictEqual(await time(`End to end ${arch}`, `Configure ${arch} Debug (defconfig)`,
					() => vscode.commands.executeCommand('kernelDev.configure')), 0);
				const st = x.settings.configured();
				assert.ok(st.makeArgs.some(a => /^CROSS_COMPILE=\S+-linux-gnu-$/.test(a)), st.makeArgs.join(' '));
				assert.match(fs.readFileSync(path.join(st.buildDir, '.config'), 'utf8'), /^CONFIG_GDB_SCRIPTS=y$/m);
				assert.strictEqual(await time(`End to end ${arch}`, `Build ${arch} (full defconfig kernel)`,
					() => vscode.commands.executeCommand('kernelDev.build')), 0);
				assert.ok(fs.existsSync(x.kbuild.image(st)), x.kbuild.image(st));
			});

			it('boots in QEMU and decodes the panic', async () => {
				const st = x.settings.configured();
				const log = x.runner.consoleLog(st);
				const show = answer('showErrorMessage', ['Show Decoded Trace']);
				try {
					await time(`End to end ${arch}`, 'Run: boot to the root-mount panic', async () => {
						await vscode.commands.executeCommand('kernelDev.run');
						await until(() => fs.existsSync(log) && /Kernel panic - not syncing/.test(fs.readFileSync(log, 'utf8')), 600000, 500);
					});
					assert.match(fs.readFileSync(log, 'utf8'), /Linux version/);
					const decoded = await time(`End to end ${arch}`, 'panic -> notification -> decoded trace', async () => {
						await until(() => x.oops.reports.size > 0 && x.oops.reports.has(String(x.oops.count)), 120000, 200);
						return x.oops.reports.get(String(x.oops.count));
					}, d => `${(d.match(/\.[ch]:\d+/g) || []).length} source locations`);
					assert.match(show.asked[0][0], /Kernel panic - not syncing/);
					assert.match(decoded, /\.c:\d+\)/, 'frames decoded with the cross addr2line');
				} finally {
					show.restore();
					await vscode.commands.executeCommand('kernelDev.stop');
				}
			});

			it('hands the debugger a guest halted at start_kernel', async () => {
				const started = [];
				const orig = vscode.debug.startDebugging;
				vscode.debug.startDebugging = async (folder, config) => { started.push(config); return true; };
				const check = x.runner.checkDebugger;
				x.runner.checkDebugger = async () => true; // no gdb front end in the test VS Code
				const errors = answer('showErrorMessage', []);
				try {
					await time(`End to end ${arch}`, 'Debug: boot halted, run to start_kernel, hand over', () => x.runner.debug());
				} finally {
					vscode.debug.startDebugging = orig;
					x.runner.checkDebugger = check;
					errors.restore();
				}
				assert.strictEqual(started.length, 1, `no debug session; errors: ${errors.asked.map(a => a[0]).join(' | ')}`);
				const st = x.settings.configured();
				const out = execFileSync(x.settings.gdbPath(), ['-q', '-nx', '-batch', '-ex', `file ${path.join(st.buildDir, 'vmlinux')}`,
					'-ex', `target remote ${started[0].miDebuggerServerAddress}`, '-ex', 'info symbol $pc', '-ex', 'kill'], { encoding: 'utf8' });
				assert.match(out, /^start_kernel/m);
				x.runner.stop();
			});
		});
	}

	after(async () => {
		await x.settings.select('arch', 'x86_64');
		for (const k of ['toolchain', 'run.kvm', 'run.initramfs', 'buildBeforeRun'])
			await cfg().update(k, undefined, vscode.ConfigurationTarget.Workspace);
	});
});

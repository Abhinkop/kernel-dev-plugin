'use strict';

// End to end: configure, build, boot and crash a real kernel, debug
// hand-over, W=1 checks with the build, and KUnit. Slow (minutes), so it
// only runs with KWB_E2E=1; it needs gcc, QEMU, gdb and a static busybox.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');
const { api, answer, tree, git } = require('./helpers');
const { time, until } = require('./perf');

const e2e = process.env.KWB_E2E === '1' ? describe : describe.skip;

e2e('End to end', function () {
	this.timeout(30 * 60 * 1000);
	let x;
	const cfg = () => vscode.workspace.getConfiguration('kernelDev', vscode.workspace.workspaceFolders[0].uri);

	before(async () => {
		x = await api();
		git('checkout', '-q', '-B', 'kwb-e2e', 'kwb-test-base');
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
		await cfg().update('toolchain', 'gcc', vscode.ConfigurationTarget.Workspace);
		await cfg().update('terminal.afterTask', 'close', vscode.ConfigurationTarget.Workspace);
	});

	it('configures with the Debug options', async () => {
		const code = await time('End to end', 'Configure x86_64 Debug (defconfig)', () => vscode.commands.executeCommand('kernelDev.configure'));
		assert.strictEqual(code, 0);
		const conf = fs.readFileSync(path.join(x.settings.buildDir(), '.config'), 'utf8');
		assert.match(conf, /^CONFIG_GDB_SCRIPTS=y$/m);
		assert.match(conf, /^CONFIG_DEBUG_INFO_DWARF_TOOLCHAIN_DEFAULT=y$/m);
	});

	it('builds and publishes compile_commands.json for clangd', async () => {
		const code = await time('End to end', 'Build (full defconfig kernel)', () => vscode.commands.executeCommand('kernelDev.build'));
		assert.strictEqual(code, 0);
		const st = x.settings.configured();
		assert.ok(fs.existsSync(x.kbuild.image(st)));
		const db = JSON.parse(fs.readFileSync(path.join(tree(), 'compile_commands.json'), 'utf8'));
		assert.ok(db.length > 1000, `${db.length} entries`);
	});

	it('runs W=1 on the files a series touches, with the build', async () => {
		fs.appendFileSync(path.join(tree(), 'drivers/gpu/drm/virtio/virtgpu_drv.c'), '\nstatic int kwb_unused;\n');
		git('commit', '-q', '-a', '-s', '-m', 'drm/virtio: add an unused variable', '-m', 'For the W=1 check.');
		await cfg().update('patches.base', 'kwb-test-base', vscode.ConfigurationTarget.Workspace);
		await time('End to end', 'Check series with W=1 on the touched file', () => vscode.commands.executeCommand('kernelDev.series.check'));
		assert.match(x.series.series.lastBuild, /^W=1 on 1 file: [1-9]\d* errors?/);
		await cfg().update('patches.base', undefined, vscode.ConfigurationTarget.Workspace);
	});

	it('boots in QEMU, and decodes a crash from the console', async () => {
		// A minimal initramfs around the host's static busybox.
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-initramfs-'));
		execFileSync('cc', ['-O2', '-o', path.join(work, 'gen_init_cpio'), path.join(tree(), 'usr/gen_init_cpio.c')]);
		fs.writeFileSync(path.join(work, 'init'), '#!/bin/busybox sh\n/bin/busybox --install -s\nmount -t proc proc /proc\necho KWB-INIT-RAN\nexec sh\n', { mode: 0o755 });
		fs.writeFileSync(path.join(work, 'list'), ['dir /dev 0755 0 0', 'nod /dev/console 0600 0 0 c 5 1', 'dir /proc 0755 0 0', 'dir /bin 0755 0 0',
			'dir /sbin 0755 0 0', 'dir /usr 0755 0 0', 'dir /usr/bin 0755 0 0', 'dir /usr/sbin 0755 0 0',
			'file /bin/busybox /bin/busybox 0755 0 0', `file /init ${work}/init 0755 0 0`].join('\n'));
		const cpio = path.join(work, 'initramfs.cpio');
		fs.writeFileSync(cpio, execFileSync(path.join(work, 'gen_init_cpio'), [path.join(work, 'list')], { maxBuffer: 256 << 20 }));
		await cfg().update('run.initramfs', { x86_64: cpio }, vscode.ConfigurationTarget.Workspace);
		await cfg().update('run.kvm', fs.existsSync('/dev/kvm') ? 'auto' : 'off', vscode.ConfigurationTarget.Workspace);
		await cfg().update('buildBeforeRun', false, vscode.ConfigurationTarget.Workspace);

		const log = x.runner.consoleLog(x.settings.configured());
		await time('End to end', 'Run: boot to the initramfs shell', async () => {
			await vscode.commands.executeCommand('kernelDev.run');
			await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('KWB-INIT-RAN'), 180000, 200);
		});
		const show = answer('showErrorMessage', ['Show Decoded Trace']);
		const decoded = await time('End to end', 'crash -> notification -> decoded trace', async () => {
			x.runner.vm.sendText('echo c > /proc/sysrq-trigger');
			await until(() => show.asked.length > 0, 60000, 100);
			await until(() => x.oops.reports.size > 0, 60000, 100);
			return x.oops.reports.get(String(x.oops.count));
		}, d => `${(d.match(/\.[ch]:\d+/g) || []).length} source locations`);
		show.restore();
		assert.match(show.asked[0][0], /sysrq triggered crash/);
		assert.match(decoded, /sysrq_handle_crash \(drivers\/tty\/sysrq\.c:\d+\)/);
		await vscode.commands.executeCommand('kernelDev.stop');
	});

	it('hands the debugger a guest halted at start_kernel', async () => {
		const started = [];
		const orig = vscode.debug.startDebugging;
		vscode.debug.startDebugging = async (folder, config) => { started.push(config); return true; };
		x.runner.checkDebugger = async () => true; // no gdb front end in the test VS Code
		const errors = answer('showErrorMessage', []);
		try {
			await time('End to end', 'Debug: boot halted, run to start_kernel, hand over', () => x.runner.debug());
		} finally {
			vscode.debug.startDebugging = orig;
			errors.restore();
		}
		assert.strictEqual(started.length, 1, `no debug session; errors: ${errors.asked.map(a => a[0]).join(' | ')}`);
		const st = x.settings.configured();
		const out = execFileSync('gdb', ['-q', '-nx', '-batch', '-ex', `file ${path.join(st.buildDir, 'vmlinux')}`,
			'-ex', `target remote ${started[0].miDebuggerServerAddress}`, '-ex', 'info symbol $pc', '-ex', 'kill'], { encoding: 'utf8' });
		assert.match(out, /^start_kernel/m);
		x.runner.stop();
	});

	it('runs KUnit tests and reports results', async () => {
		await cfg().update('kunit.kunitconfig', 'lib/kunit', vscode.ConfigurationTarget.Workspace);
		const run = await time('End to end', 'KUnit: lib/kunit suites in QEMU', async () => {
			const before = x.kunit.controller.items.size;
			await x.kunit.run(new vscode.TestRunRequest(), new vscode.CancellationTokenSource().token);
			return before;
		});
		const ids = [];
		x.kunit.controller.items.forEach(i => i.children.forEach(c => ids.push(c.id)));
		assert.ok(ids.includes('example'), ids.join(','));
		await cfg().update('kunit.kunitconfig', undefined, vscode.ConfigurationTarget.Workspace);
	});

	it('configures and builds a Release kernel with LLVM', async () => {
		// From the clean base: the W=1 test's unused variable is an error
		// for clang with the defconfig's CONFIG_WERROR.
		git('checkout', '-q', '-f', 'kwb-test-base');
		await x.settings.select('variant', 'release');
		await cfg().update('toolchain', 'llvm', vscode.ConfigurationTarget.Workspace);
		try {
			assert.strictEqual(await time('End to end', 'Configure x86_64 Release with LLVM', () => vscode.commands.executeCommand('kernelDev.configure')), 0);
			const st = x.settings.configured();
			assert.strictEqual(st.variant, 'release');
			assert.ok(st.makeArgs.includes('LLVM=1'), st.makeArgs.join(' '));
			assert.match(st.buildDir, /x86_64[/\\]release$/);
			const conf = fs.readFileSync(path.join(st.buildDir, '.config'), 'utf8');
			assert.match(conf, /^CONFIG_CC_IS_CLANG=y$/m);
			assert.doesNotMatch(conf, /^CONFIG_GDB_SCRIPTS=y$/m, 'Release has no debug options');
			assert.strictEqual(await time('End to end', 'Build x86_64 Release with LLVM', () => vscode.commands.executeCommand('kernelDev.build')), 0);
			assert.ok(fs.existsSync(x.kbuild.image(st)));
			const db = JSON.parse(fs.readFileSync(path.join(tree(), 'compile_commands.json'), 'utf8'));
			assert.ok(db.some(e => /clang/.test(e.command || (e.arguments || []).join(' '))), 'clangd gets the clang build');
		} finally {
			await x.settings.select('variant', 'debug');
			await cfg().update('toolchain', 'gcc', vscode.ConfigurationTarget.Workspace);
		}
	});

	after(async () => {
		for (const k of ['toolchain', 'terminal.afterTask', 'run.initramfs', 'run.kvm', 'buildBeforeRun'])
			await cfg().update(k, undefined, vscode.ConfigurationTarget.Workspace);
	});
});

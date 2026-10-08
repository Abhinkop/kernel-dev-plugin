'use strict';

// End to end for the other ways of working with the x86_64 kernel:
//  - menuconfig, driven with keystrokes in its terminal;
//  - sharing the build directory with the guest over 9p and insmod-ing a
//    module built in the tree, without rebuilding the initramfs;
//  - booting with virtme-ng (the host's root file system).
// Only with KWB_E2E=1.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { api, git, sleep, busyboxInitramfs } = require('./helpers');
const { time, until } = require('./perf');

const e2e = process.env.KWB_E2E === '1' ? describe : describe.skip;

e2e('End to end, menuconfig, 9p modules, virtme-ng', function () {
	this.timeout(30 * 60 * 1000);
	let x;
	const cfg = () => vscode.workspace.getConfiguration('kernelDev', vscode.workspace.workspaceFolders[0].uri);
	const set = (k, v) => cfg().update(k, v, vscode.ConfigurationTarget.Workspace);
	const KEYS = ['run.mode', 'run.shareBuildDir', 'run.initramfs', 'run.virtmeArgs', 'run.kvm', 'configure.options', 'buildBeforeRun', 'toolchain'];

	before(async () => {
		x = await api();
		git('checkout', '-q', '-f', '-B', 'kwb-e2e-modes', 'kwb-test-base');
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
		await set('toolchain', 'gcc');
		await set('buildBeforeRun', false);
		await set('run.kvm', fs.existsSync('/dev/kvm') ? 'auto' : 'off');
	});

	const configureAndBuild = async (what) => {
		assert.strictEqual(await time('End to end', `Configure (${what})`, () => vscode.commands.executeCommand('kernelDev.configure')), 0);
		assert.strictEqual(await time('End to end', `Build (${what})`, () => vscode.commands.executeCommand('kernelDev.build')), 0);
		return x.settings.configured();
	};

	it('runs menuconfig in a terminal, saves a change, and closes the terminal', async () => {
		const st = x.settings.configured() || await configureAndBuild('for menuconfig');
		const dotconfig = path.join(st.buildDir, '.config');
		assert.doesNotMatch(fs.readFileSync(dotconfig, 'utf8'), /^CONFIG_LOCALVERSION="-kwb"$/m);
		await vscode.commands.executeCommand('kernelDev.menuconfig');
		const find = () => vscode.window.terminals.find(t => t.name === `menuconfig ${st.arch} ${st.variant}`);
		await until(find, 10000);
		const term = find();
		// In an editor tab, where it has room (menuconfig needs 19x80).
		await until(() => vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputTerminal), 10000)
			.catch(() => assert.fail('menuconfig opens in the editor area'));
		// make builds mconf first; then give it a moment to draw.
		await time('End to end', 'menuconfig: build mconf and start', () =>
			until(() => fs.existsSync(path.join(st.buildDir, 'scripts', 'kconfig', 'mconf')), 120000, 250));
		await sleep(3000);
		// Search for LOCALVERSION, jump to it, type a value, then leave
		// with Esc Esc and save, as a user would.
		const keys = async (k, wait = 1200) => { term.sendText(k, false); await sleep(wait); };
		await keys('/');
		await keys('LOCALVERSION\r');
		await keys('1');
		await keys('\r');
		await keys('-kwb\r');
		// Back out: General setup, the search results, the main menu.
		for (let i = 0; i < 3; i++)
			await keys('\x1b\x1b', 1500);
		await keys('\r', 3000); // "Do you wish to save your new configuration?" <Yes>
		await until(() => /^CONFIG_LOCALVERSION="-kwb"$/m.test(fs.readFileSync(dotconfig, 'utf8')), 30000, 250);
		await until(() => !vscode.window.terminals.includes(term), 30000, 250);
	});

	it('shares the build directory over 9p and loads a module built in the tree', async () => {
		await set('run.shareBuildDir', true);
		await set('configure.options', { DUMMY: 'm' });
		await set('run.initramfs', { x86_64: busyboxInitramfs() });
		const st = await configureAndBuild('9p share, DUMMY=m');
		const conf = fs.readFileSync(path.join(st.buildDir, '.config'), 'utf8');
		assert.match(conf, /^CONFIG_9P_FS=y$/m);
		assert.match(conf, /^CONFIG_NET_9P_VIRTIO=y$/m);
		assert.match(conf, /^CONFIG_DUMMY=m$/m);
		assert.ok(fs.existsSync(path.join(st.buildDir, 'drivers/net/dummy.ko')));

		const log = x.runner.consoleLog(st);
		const has = (re) => fs.existsSync(log) && re.test(fs.readFileSync(log, 'utf8'));
		try {
			await vscode.commands.executeCommand('kernelDev.run');
			await until(() => has(/KWB-INIT-RAN/), 180000, 200);
			await time('End to end', '9p: mount the build directory and insmod a module', async () => {
				x.runner.vm.sendText('mkdir -p /mnt/kbuild && mount -t 9p -o trans=virtio,version=9p2000.L kbuild /mnt/kbuild && ' +
					'insmod /mnt/kbuild/drivers/net/dummy.ko && echo KWB-INSMOD-$(grep -c "^dummy " /proc/modules)');
				await until(() => has(/KWB-INSMOD-1/), 60000, 200);
			});
			assert.ok(!has(/KWB-INSMOD-0|Invalid module format|insmod: can't/), fs.readFileSync(log, 'utf8').slice(-2000));
		} finally {
			await vscode.commands.executeCommand('kernelDev.stop');
			await set('run.shareBuildDir', undefined);
			await set('configure.options', undefined);
			await set('run.initramfs', undefined);
		}
	});

	it('boots with virtme-ng on the host\'s root file system', async () => {
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-vng-'));
		const mark = path.join(out, 'vng-uname');
		await set('run.mode', 'virtme');
		// virtme-ng shares the host's file systems read-only; this one is
		// writable so the guest can leave a mark. --exec runs the command in
		// the guest, then vng exits (typing into the VM terminal is covered
		// by the 9p test).
		await set('run.virtmeArgs', ['--rwdir', out, '--exec', `uname -r > ${mark}`]);
		const st = await configureAndBuild('virtme-ng options');
		const conf = fs.readFileSync(path.join(st.buildDir, '.config'), 'utf8');
		for (const o of ['VIRTIO_FS', 'OVERLAY_FS', '9P_FS', 'VIRTIO_CONSOLE'])
			assert.match(conf, new RegExp(`^CONFIG_${o}=y$`, 'm'), o);
		const release = fs.readFileSync(path.join(st.buildDir, 'include/config/kernel.release'), 'utf8').trim();
		try {
			await vscode.commands.executeCommand('kernelDev.run');
			const term = x.runner.vm;
			assert.ok(term, 'the VM terminal');
			assert.strictEqual(term.creationOptions.shellArgs[3], 'vng', 'Run uses vng in virtme mode');
			const exitFile = path.join(st.buildDir, 'kernel-dev', 'vm.exit');
			await time('End to end', 'virtme-ng: boot on the host root, run a command, exit', () =>
				until(() => fs.existsSync(exitFile), 240000, 250));
			assert.strictEqual(fs.readFileSync(exitFile, 'utf8').trim(), '0', 'vng exited cleanly');
			assert.strictEqual(fs.readFileSync(mark, 'utf8').trim(), release, 'the guest ran the kernel just built');
			// A clean exit closes the VM terminal.
			await until(() => !vscode.window.terminals.includes(term), 30000, 250);
			assert.ok(!x.runner.running);
		} finally {
			await vscode.commands.executeCommand('kernelDev.stop');
			await set('run.mode', undefined);
			await set('run.virtmeArgs', undefined);
		}
	});

	after(async () => {
		for (const k of KEYS)
			await set(k, undefined);
	});
});

'use strict';

// End to end with the real debugger: Debug boots the x86_64 Debug kernel
// halted, runs it to start_kernel and hands it to the C/C++ extension
// (ms-vscode.cpptools, installed for the test run), whose session must
// stop there with a usable stack. Only with KWB_E2E=1, after
// 4-e2e.test.js built the kernel.

const assert = require('assert');
const vscode = require('vscode');
const { api } = require('./helpers');
const { time } = require('./perf');

/** Poll fn() until it returns something truthy, and return that. */
async function poll(fn, timeout, what) {
	const t0 = Date.now();
	for (;;) {
		const r = await fn().catch(() => undefined);
		if (r)
			return r;
		if (Date.now() - t0 > timeout)
			throw new Error(`timed out waiting for ${what}`);
		await new Promise(res => setTimeout(res, 250));
	}
}

const e2e = process.env.KWB_E2E === '1' && vscode.extensions.getExtension('ms-vscode.cpptools') ? describe : describe.skip;

e2e('End to end, real debugger', function () {
	this.timeout(10 * 60 * 1000);
	let x;

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		const cfg = vscode.workspace.getConfiguration('kernelDev', vscode.workspace.workspaceFolders[0].uri);
		await cfg.update('buildBeforeRun', false, vscode.ConfigurationTarget.Workspace);
		// Stay where the hand-off stopped instead of continuing (the default).
		await cfg.update('debug.stopOnEntry', true, vscode.ConfigurationTarget.Workspace);
	});

	it('attaches the C/C++ debugger to the guest at start_kernel', async () => {
		assert.ok(x.settings.configured(), 'the x86_64 Debug kernel from 4-e2e.test.js');
		/** @type {vscode.DebugSession | undefined} */
		let session;
		/** @type {any} */
		let stopped;
		const tracker = vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', {
			createDebugAdapterTracker: () => ({
				onDidSendMessage: (m) => {
					if (m.type === 'event' && m.event === 'stopped')
						stopped = m.body;
				},
			}),
		});
		try {
			await time('End to end', 'Debug with cpptools: boot, run to start_kernel, attach', async () => {
				await x.runner.debug();
				session = await poll(async () => vscode.debug.activeDebugSession, 120000, 'the debug session');
			});
			assert.strictEqual(session.type, 'cppdbg');
			assert.strictEqual(session.configuration.program, x.kbuild.vmlinux(x.settings.configured()));
			const threads = await poll(async () => {
				const r = await session.customRequest('threads');
				return r.threads.length && r.threads;
			}, 60000, 'threads');
			await poll(async () => stopped, 60000, 'the debugger to report the stop');
			const frames = await poll(async () => {
				const r = await session.customRequest('stackTrace', { threadId: (stopped && stopped.threadId) || threads[0].id, levels: 5 });
				return r.stackFrames.length && r.stackFrames;
			}, 60000, 'a stack');
			assert.match(frames[0].name, /start_kernel/, frames.map(f => f.name).join(' < '));
			assert.match(frames[0].source.path, /init[/\\]main\.c$/);
		} finally {
			tracker.dispose();
			if (vscode.debug.activeDebugSession)
				await vscode.debug.stopDebugging();
			await poll(async () => !vscode.debug.activeDebugSession, 30000, 'the session to end').catch(() => {});
			// debug.stopVmWhenDebuggingEnds (default on) stops QEMU with it.
			await poll(async () => !x.runner.running, 30000, 'the VM to stop').catch(() => x.runner.stop());
		}
	});

	after(async () => {
		const cfg = vscode.workspace.getConfiguration('kernelDev', vscode.workspace.workspaceFolders[0].uri);
		for (const k of ['buildBeforeRun', 'debug.stopOnEntry'])
			await cfg.update(k, undefined, vscode.ConfigurationTarget.Workspace);
	});
});

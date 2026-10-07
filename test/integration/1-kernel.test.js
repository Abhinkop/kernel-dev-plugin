'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { ID, api, labels, child, answer, sleep, file } = require('./helpers');
const { time, until } = require('./perf');

describe('Kernel Workbench in VS Code', function () {
	let x;

	it('activates in a kernel tree', async () => {
		const ext = vscode.extensions.getExtension(ID);
		x = await time('Activation', 'activate()', () => api(), () => `extension ${ext.packageJSON.version}`);
		assert.ok(ext.isActive);
		assert.ok(x.settings && x.kernelView && x.series && x.apply && x.bisect && x.history);
	});

	it('registers every contributed command', async () => {
		const all = new Set(await vscode.commands.getCommands(true));
		const contributed = vscode.extensions.getExtension(ID).packageJSON.contributes.commands.map(c => c.command);
		assert.deepStrictEqual(contributed.filter(c => !all.has(c)), []);
	});

	it('opens every view', async () => {
		for (const [id, area] of [['kernelDev.kernel', 'Kernel tab'], ['kernelDev.series', 'Kernel Git tab'], ['kernelDev.apply', 'Kernel Git tab'],
			['kernelDev.bisect', 'Kernel Git tab'], ['kernelDev.history', 'History tab'], ['kernelDev.blame', 'History tab']])
			await time(area, `open view ${id.split('.')[1]}`, () => vscode.commands.executeCommand(`${id}.focus`));
	});

	describe('Kernel view', () => {
		it('shows steps, target, status and options', async () => {
			const top = await time('Kernel tab', 'render Kernel view (5 groups, 2 levels)', () => labels(x.kernelView, undefined, 2),
				l => `${l.length} rows`);
			assert.deepStrictEqual(top.filter(l => !l.startsWith(' ')), ['Steps', 'More', 'Target', 'Status', 'Options']);
			assert.ok(top.some(l => /^ {2}Build — /.test(l)));
			assert.ok(top.some(l => /^ {2}Architecture — /.test(l)));
			assert.ok(top.some(l => /^ {2}Build — Debug/.test(l)));
			assert.ok(top.some(l => /^ {2}VM — stopped/.test(l)));
		});

		it('changes the architecture through the real quick pick', async () => {
			const before = x.settings.arch;
			const picked = vscode.commands.executeCommand('kernelDev.selectArch');
			await sleep(400);
			// The quick pick is open on the first entry (x86_64): move to the
			// next one and accept it, as a user would with the keyboard.
			await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			await picked;
			assert.strictEqual(x.settings.arch, 'arm64');
			const target = await child(x.kernelView, 'Target');
			assert.match((await labels(x.kernelView, target))[0], /^Architecture — arm64/);
			await x.settings.select('arch', before);
		});

		it('edits options from their items', async () => {
			const options = await child(x.kernelView, 'Options');
			const ccache = await child(x.kernelView, 'ccache', options);
			const cfg = () => vscode.workspace.getConfiguration('kernelDev', vscode.workspace.workspaceFolders[0].uri);
			const before = cfg().get('make.ccache');
			await time('Kernel tab', 'toggle an option (ccache) and re-render', async () => {
				await vscode.commands.executeCommand('kernelDev.editItem', ccache);
				await until(async () => cfg().get('make.ccache') === !before);
			});
			const p = answer('showInputBox', ['W=1 "KCFLAGS=-Og -g"']);
			await vscode.commands.executeCommand('kernelDev.editItem', await child(x.kernelView, 'Extra make arguments', options));
			p.restore();
			assert.deepStrictEqual(cfg().get('make.args'), ['W=1', 'KCFLAGS=-Og -g']);
			const fresh = await child(x.kernelView, 'Options');
			assert.match((await labels(x.kernelView, fresh)).find(l => l.startsWith('Extra make')), /W=1 "KCFLAGS=-Og -g"/);
			await cfg().update('make.ccache', undefined, vscode.ConfigurationTarget.Global);
			await cfg().update('make.args', undefined, vscode.ConfigurationTarget.Global);
		});

		it('checks the host tools', async () => {
			// The check waits for its notification (if any) to be dismissed.
			const n = answer('showWarningMessage', [undefined]);
			await time('Kernel tab', 'tool check', () => x.checkTools(true));
			n.restore();
			const status = await child(x.kernelView, 'Status');
			assert.ok((await labels(x.kernelView, status)).some(l => /^Tools — /.test(l)));
		});
	});

	describe('terminals', () => {
		const names = () => vscode.window.terminals.map(t => t.name);

		it('closes a step\'s terminal when it succeeds and keeps it when it fails', async () => {
			const { runTask } = require(require('path').join(vscode.extensions.getExtension(ID).extensionPath, 'src', 'tasks.js'));
			const folder = vscode.workspace.workspaceFolders[0];
			await time('Terminals', 'step that succeeds: run, close its terminal', async () => {
				assert.strictEqual(await runTask(folder, 'KWB ok step', 'sh', ['-c', 'echo fine']), 0);
				await until(() => !names().some(n => n.includes('KWB ok step')), 5000);
			});
			assert.strictEqual(await runTask(folder, 'KWB failing step', 'sh', ['-c', 'echo broken >&2; exit 2']), 2);
			await sleep(500);
			assert.ok(names().some(n => n.includes('KWB failing step')), `kept: ${names().join(', ')}`);
			vscode.window.terminals.find(t => t.name.includes('KWB failing step'))?.dispose();
		});

		it('closes the VM terminal when QEMU exits cleanly, and keeps it when it fails', async () => {
			const r = x.runner;
			const orig = r.vmCommand;
			const st = { arch: 'x86_64', variant: 'debug', buildDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kwb-vm-')) };
			try {
				r.vmCommand = () => ({ cmd: 'sh', args: ['-c', 'exit 0'] });
				r.boot(st, false);
				const ok = r.vm;
				await until(() => !vscode.window.terminals.includes(ok), 10000);
				r.vmCommand = () => ({ cmd: 'sh', args: ['-c', 'echo qemu: could not open kernel >&2; exit 1'] });
				r.boot(st, false);
				const bad = r.vm;
				await until(() => !r.running, 10000);
				await sleep(500);
				assert.ok(vscode.window.terminals.includes(bad), 'a failed QEMU leaves its terminal to read');
				assert.strictEqual(bad.exitStatus, undefined);
			} finally {
				r.vmCommand = orig;
				r.stop();
			}
		});
	});

	describe('editor', () => {
		it('opens kernel source files and offers the Kernel Workbench menu', async () => {
			const doc = await time('Editor', 'open kernel/sched/core.c', async () => vscode.window.showTextDocument(file('kernel/sched/core.c')));
			assert.strictEqual(doc.document.languageId, 'c');
		});
	});
});

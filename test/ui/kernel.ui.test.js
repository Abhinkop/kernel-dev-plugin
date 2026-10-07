'use strict';

// What a user sees and clicks, in a real VS Code window driven by
// vscode-extension-tester: the Kernel tab's rows, the editor toolbar,
// right-click menus, pickers, and the step terminals.

const assert = require('assert');
const path = require('path');
const { VSBrowser, ActivityBar, EditorView, TextEditor, InputBox, Workbench } = require('vscode-extension-tester');

const tree = () => /** @type {string} */ (process.env.KWB_TREE);

/** Poll until fn() returns something truthy. */
async function until(fn, timeout = 30000, what = 'condition') {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await fn();
			if (r)
				return r;
		} catch {}
		if (Date.now() - t0 > timeout)
			throw new Error(`timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 250));
	}
}

describe('Kernel Workbench, clicked through', function () {
	this.timeout(10 * 60 * 1000);
	/** @type {import('vscode-extension-tester').CustomTreeSection} */
	let kernel;

	before(async () => {
		await VSBrowser.instance.waitForWorkbench();
		const control = await until(() => new ActivityBar().getViewControl('Kernel'), 60000, 'the Kernel icon in the activity bar');
		const view = await control.openView();
		kernel = /** @type {any} */ (await until(() => view.getContent().getSection('Kernel'), 30000, 'the Kernel view'));
	});

	const row = (label) => until(() => kernel.findItem(label, 3), 20000, `row "${label}"`);
	/** Expand a group row as a user would, by clicking its twistie. */
	const open = async (label) => {
		const g = await row(label);
		if (!(await g.isExpanded()))
			await g.expand();
	};
	const description = async (label) => (await row(label)).getDescription();
	/** Open terminals, by name, from VS Code's terminal switcher (quick open "term "). */
	const terminals = async () => {
		const input = await new Workbench().openCommandPrompt();
		await input.setText('term ');
		await new Promise(r => setTimeout(r, 500));
		const names = await Promise.all((await input.getQuickPicks()).map(p => p.getLabel()));
		await input.cancel();
		return names.filter(n => !/^Create New Terminal|^No matching/.test(n));
	};

	it('shows the steps as labelled rows', async () => {
		for (const label of ['Configure', 'Build', 'Run', 'Debug'])
			assert.ok(await row(label), label);
		assert.match(await description('Build'), /x86_64 Debug/);
	});

	it('right-clicking a target row offers only "Change…"', async () => {
		const menu = await (await row('Architecture')).openContextMenu();
		const labels = await Promise.all((await menu.getItems()).map(i => i.getLabel()));
		await menu.close();
		assert.deepStrictEqual(labels, ['Change…']);
	});

	it('clicking Architecture opens the architecture picker', async () => {
		await (await row('Architecture')).click();
		const input = await InputBox.create();
		const picks = await Promise.all((await input.getQuickPicks()).map(p => p.getLabel()));
		await input.cancel();
		for (const a of ['x86_64', 'arm64', 'riscv64'])
			assert.ok(picks.some(p => p.startsWith(a)), `${a} in ${picks.join(', ')}`);
	});

	it('clicking an on/off option flips it', async () => {
		await open('Options');
		const before = await description('ccache');
		await (await row('ccache')).click();
		await until(async () => (await description('ccache')) !== before, 10000, 'ccache to change');
		await (await row('ccache')).click();
		await until(async () => (await description('ccache')) === before, 10000, 'ccache to change back');
	});

	it('clicking Configure configures, and its terminal closes when it succeeds', async () => {
		assert.strictEqual(await description('Configured'), 'not yet');
		await (await row('Configure')).click();
		await until(async () => (await description('Configured')) !== 'not yet', 180000, 'Configure to finish');
		// The Configure terminal opened, and closed when it succeeded.
		await until(async () => !(await terminals()).some(n => /Configure/.test(n)), 15000, 'the Configure terminal to close');
	});

	it('a failing Build keeps its terminal open to read the error', async () => {
		// An unknown make target makes Build fail at once.
		await (await row('Extra make arguments')).click();
		const input = await InputBox.create();
		await input.setText('kwb-no-such-target');
		await input.confirm();
		await until(async () => /kwb-no-such-target/.test(await description('Extra make arguments')), 10000, 'the option to be set');
		await (await row('Build')).click();
		const names = await until(async () => {
			const n = await terminals();
			return n.some(x => /Build x86_64/.test(x)) && !(await kernel.findItem('Running', 3).catch(() => undefined)) && n;
		}, 120000, 'Build to fail');
		await new Promise(r => setTimeout(r, 3000));
		assert.ok((await terminals()).some(x => /Build x86_64/.test(x)), `the failed Build's terminal stays: ${names.join(', ')}`);
		assert.match(await description('Built'), /not yet/);
		await (await row('Extra make arguments')).click();
		const clear = await InputBox.create();
		await clear.setText('');
		await clear.confirm();
	});

	describe('editor', () => {
		before(async () => {
			await VSBrowser.instance.openResources(path.join(tree(), 'kernel/sched/core.c'));
			await until(async () => (await new EditorView().getOpenEditorTitles()).includes('core.c'), 30000, 'core.c to open');
		});

		it('has Configure, Build, Run and Debug on the toolbar', async () => {
			const view = new EditorView();
			const titles = await until(async () => {
				const t = await Promise.all((await view.getActions()).map(a => a.getTitle()));
				return t.length > 3 && t;
			}, 10000, 'the editor toolbar');
			for (const title of ['Configure', 'Build', 'Run in QEMU', 'Debug in QEMU'])
				assert.ok(titles.some(t => t === title || t.startsWith(`${title} (`)), `"${title}" in ${titles.join(' | ')}`);
		});

		it('right-click offers the Kernel Workbench menu, not the steps', async () => {
			const menu = await new TextEditor().openContextMenu();
			const labels = await Promise.all((await menu.getItems()).map(i => i.getLabel()));
			assert.ok(labels.includes('Kernel Workbench'), labels.join(', '));
			assert.ok(!labels.includes('Build') && !labels.includes('Configure'), labels.join(', '));
			await menu.close();
			// The submenu's own items are checked against the manifest in the
			// unit tests (test/unit/extension.test.js, "menus").
		});

		after(async () => {
			await new EditorView().closeAllEditors();
			await new Workbench().executeCommand('Terminal: Kill All Terminals').catch(() => {});
		});
	});
});

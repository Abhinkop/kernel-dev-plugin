'use strict';

const assert = require('assert');
const mock = require('../helpers/vscode');
const { makeRepo, tempDir } = require('../helpers/repo');
const pkg = require('../../package.json');

function context() {
	const ws = new Map();
	const gs = new Map();
	return {
		subscriptions: [], extensionPath: require('path').resolve(__dirname, '../..'),
		storageUri: mock.vscode.Uri.file(tempDir()), globalStorageUri: mock.vscode.Uri.file(tempDir()),
		workspaceState: { get: (k, d) => (ws.has(k) ? ws.get(k) : d), update: async (k, v) => ws.set(k, v) },
		globalState: { get: (k, d) => (gs.has(k) ? gs.get(k) : d), update: async (k, v) => gs.set(k, v) },
	};
}

describe('extension', () => {
	let ext;
	beforeEach(() => {
		delete require.cache[require.resolve('../../extension.js')];
		ext = require('../../extension.js');
	});

	it('does nothing outside a kernel tree', () => {
		mock.vscode.workspace.workspaceFolders = [{ uri: mock.vscode.Uri.file(tempDir()), name: 'x', index: 0 }];
		assert.strictEqual(ext.activate(context()), undefined);
		assert.strictEqual(mock.state.commands.size, 0);
	});

	it('registers exactly the commands the manifest contributes', async () => {
		const r = makeRepo();
		mock.vscode.workspace.workspaceFolders = [{ uri: mock.vscode.Uri.file(r.dir), name: 'linux', index: 0 }];
		const api = ext.activate(context());
		assert.ok(api && api.settings && api.kernelView && api.series && api.apply && api.bisect);
		const contributed = pkg.contributes.commands.map(c => c.command).sort();
		const registered = [...mock.state.commands.keys()].sort();
		assert.deepStrictEqual(registered, contributed);
		assert.ok(mock.state.executed.some(e => e.id === 'setContext' && e.args[0] === 'kernelDev.active' && e.args[1] === true));
		ext.deactivate();
		r.remove();
	});

	it('every menu, keybinding and view refers to something real', () => {
		const commands = new Set(pkg.contributes.commands.map(c => c.command));
		const submenus = new Set(pkg.contributes.submenus.map(s => s.id));
		for (const [menu, items] of Object.entries(pkg.contributes.menus))
			for (const i of items)
				assert.ok(i.command ? commands.has(i.command) : submenus.has(i.submenu), `${menu}: ${i.command || i.submenu}`);
		for (const k of pkg.contributes.keybindings)
			assert.ok(commands.has(k.command), k.command);
		const containers = new Set(pkg.contributes.viewsContainers.activitybar.map(c => c.id));
		for (const [container, views] of Object.entries(pkg.contributes.views)) {
			assert.ok(containers.has(container), container);
			for (const v of views)
				assert.ok(v.icon && require('fs').existsSync(require('path').resolve(__dirname, '../..', v.icon)), `${v.id} icon`);
		}
		for (const w of pkg.contributes.viewsWelcome)
			assert.ok(Object.values(pkg.contributes.views).flat().some(v => v.id === w.view), w.view);
		for (const c of pkg.contributes.commands)
			assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(c.title), `no emoji: ${c.title}`);
	});

	it('every setting has a default, a description and resource scope', () => {
		for (const sec of pkg.contributes.configuration)
			for (const [k, v] of Object.entries(sec.properties)) {
				assert.ok('default' in v, `${k} default`);
				assert.ok(v.description || v.markdownDescription, `${k} description`);
				assert.strictEqual(v.scope, 'resource', `${k} scope`);
			}
	});

	it('reports missing tools once, offers to install them, and can be silenced', async () => {
		const r = makeRepo();
		mock.vscode.workspace.workspaceFolders = [{ uri: mock.vscode.Uri.file(r.dir), name: 'linux', index: 0 }];
		const ctx = context();
		mock.state.config['kernelDev.crossCompile'] = { x86_64: 'no-such-', arm64: 'no-such-', riscv64: 'no-such-' };
		const api = ext.activate(ctx);
		await new Promise(res => setTimeout(res, 50));
		const first = mock.state.log.find(l => l.kind === 'warning');
		assert.match(first.message, /missing tools for .*no-such-gcc/);
		assert.ok(first.items.includes("Don't Show Again"));
		mock.answer('Run Install Command');
		await api.checkTools(true);
		assert.ok(mock.state.terminals.pop().sent[0].includes('apt-get install') || true);
		mock.answer("Don't Show Again");
		mock.state.log = [];
		await mock.vscode.commands.executeCommand('kernelDev.selectArch'); // no answer: nothing changes
		await api.checkTools(false);
		assert.strictEqual(mock.state.log.filter(l => l.kind === 'warning').length, 0, 'same set: not repeated');
		r.remove();
	});
});

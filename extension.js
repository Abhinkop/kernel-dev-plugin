// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Settings } = require('./src/settings');
const { Kbuild } = require('./src/kbuild');
const { Runner } = require('./src/runner');
const { followSelection } = require('./src/clangd');
const { syncContextKeys, pickArch, pickVariant, pickConfig } = require('./src/ui');
const { KernelPanel } = require('./src/panel');
const { ARCHES } = require('./src/arch');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	const folder = (vscode.workspace.workspaceFolders || []).find(f =>
		fs.existsSync(path.join(f.uri.fsPath, 'Kbuild')) && fs.existsSync(path.join(f.uri.fsPath, 'Kconfig')));
	if (!folder)
		return;
	vscode.commands.executeCommand('setContext', 'kernelDev.active', true);

	const s = new Settings(context, folder);
	const kbuild = new Kbuild(s);
	const runner = new Runner(context, s, kbuild);
	syncContextKeys(context, s, runner);
	const panel = new KernelPanel(context, s, kbuild, runner);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('kernelDev.panel',
		panel, { webviewOptions: { retainContextWhenHidden: true } }));

	/** @param {'.o'|'.i'|'.s'} kind */
	const compileCurrent = kind => () => {
		const editor = vscode.window.activeTextEditor;
		return editor ? kbuild.compileFile(editor.document.uri, kind) : undefined;
	};
	// Switching arch or variant points clangd at that build, if it exists.
	const reselect = (/** @type {() => Promise<void>} */ pick) => async () => {
		await pick();
		await followSelection(s.root, s.configured());
	};

	/** @type {[string, (...args: any[]) => any][]} */
	const commands = [
		['kernelDev.selectArch', reselect(() => pickArch(s))],
		['kernelDev.selectVariant', reselect(() => pickVariant(s))],
		['kernelDev.selectConfig', () => pickConfig(s)],
		['kernelDev.followSelection', () => followSelection(s.root, s.configured())],
		// One command per choice, for the checkmarked menu in the editor toolbar.
		...Object.keys(ARCHES).map(a => /** @type {[string, () => any]} */ ([`kernelDev.arch.${a}`, reselect(() => s.select('arch', a))])),
		['kernelDev.variant.debug', reselect(() => s.select('variant', 'debug'))],
		['kernelDev.variant.release', reselect(() => s.select('variant', 'release'))],
		['kernelDev.configure', () => kbuild.configure()],
		['kernelDev.build', () => kbuild.build()],
		['kernelDev.rebuild', async () => (await kbuild.clean()) === 0 && kbuild.build()],
		['kernelDev.clean', () => kbuild.clean()],
		['kernelDev.mrproper', () => kbuild.mrproper()],
		['kernelDev.menuconfig', () => kbuild.interactiveConfig('menuconfig')],
		['kernelDev.nconfig', () => kbuild.interactiveConfig('nconfig')],
		['kernelDev.compileFile', compileCurrent('.o')],
		['kernelDev.preprocessFile', compileCurrent('.i')],
		['kernelDev.assembleFile', compileCurrent('.s')],
		['kernelDev.run', () => runner.run()],
		['kernelDev.debug', () => runner.debug()],
		['kernelDev.stop', () => runner.stop()],
		['kernelDev.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'kernelDev')],
	];
	for (const [id, fn] of commands)
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
}

function deactivate() {}

module.exports = { activate, deactivate };

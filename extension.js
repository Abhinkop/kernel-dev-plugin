// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Settings } = require('./src/settings');
const { Kbuild } = require('./src/kbuild');
const { Runner } = require('./src/runner');

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

	/** @param {'.o'|'.i'|'.s'} kind */
	const compileCurrent = kind => () => {
		const editor = vscode.window.activeTextEditor;
		return editor ? kbuild.compileFile(editor.document.uri, kind) : undefined;
	};

	/** @type {[string, (...args: any[]) => any][]} */
	const commands = [
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

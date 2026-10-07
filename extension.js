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
const tools = require('./src/tools');
const { SCHEME, GitDocuments } = require('./src/commits');
const { registerHistory } = require('./src/history');
const { registerBlame } = require('./src/blame');

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

	// Kernel Git tab.
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitDocuments(s.root)));
	registerBlame(context, s.root);
	registerHistory(context, s.root);

	// Check the host for everything the current selection needs: when the
	// extension loads and whenever arch / toolchain / run mode change. The
	// error is shown once per distinct set of missing tools.
	let lastShown = '';
	/** @param {boolean} [always] show the result even if unchanged / all present */
	const checkTools = async always => {
		const missing = tools.missing(s);
		const text = tools.describe(missing);
		const cmd = tools.installCommand(missing);
		panel.setTools(text, cmd);
		if (!missing.length) {
			lastShown = '';
			if (always)
				vscode.window.showInformationMessage(`Kernel: all tools for ${s.arch} are installed.`);
			return;
		}
		if (!always && text === lastShown)
			return;
		lastShown = text;
		const buttons = cmd ? ['Run Install Command', 'Copy Command'] : [];
		if (missing.some(r => r.what.startsWith('initramfs ')))
			buttons.push('Open Kernel Panel');
		const pick = await vscode.window.showErrorMessage(
			`Kernel: missing tools for ${s.arch}, ${describe(s)}: ${text}.` + (cmd ? ` Install with: ${cmd}` : ''), ...buttons);
		if (pick === 'Run Install Command')
			runInstall(cmd);
		else if (pick === 'Copy Command')
			await vscode.env.clipboard.writeText(cmd);
		else if (pick === 'Open Kernel Panel')
			await vscode.commands.executeCommand('workbench.view.extension.kernelDev');
	};
	/** @param {string} cmd */
	const runInstall = cmd => {
		const term = vscode.window.createTerminal({ name: 'Install kernel tools', cwd: s.root });
		term.show();
		term.sendText(cmd);
	};
	let pending = /** @type {NodeJS.Timeout | undefined} */ (undefined);
	s.onDidChange(() => {
		clearTimeout(pending);
		pending = setTimeout(() => checkTools(false), 500);
	});
	checkTools(false);

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
		['kernelDev.checkTools', () => checkTools(true)],
		['kernelDev.installTools', () => {
			const cmd = tools.installCommand(tools.missing(s));
			if (cmd)
				runInstall(cmd);
		}],
		['kernelDev.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'kernelDev')],
	];
	for (const [id, fn] of commands)
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
}

/** "gcc" / "llvm", "qemu" / "virtme" @param {import('./src/settings').Settings} s */
function describe(s) {
	return `${s.get('toolchain', 'gcc')}, ${s.get('run.mode', 'qemu')}`;
}

function deactivate() {}

module.exports = { activate, deactivate };

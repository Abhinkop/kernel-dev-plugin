// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	const folder = (vscode.workspace.workspaceFolders || []).find(f =>
		fs.existsSync(path.join(f.uri.fsPath, 'Kbuild')) && fs.existsSync(path.join(f.uri.fsPath, 'Kconfig')));
	if (!folder)
		return;
	vscode.commands.executeCommand('setContext', 'kernelDev.active', true);
}

function deactivate() {}

module.exports = { activate, deactivate };

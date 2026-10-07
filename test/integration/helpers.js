'use strict';

const vscode = require('vscode');
const path = require('path');
const { execFileSync } = require('child_process');

const ID = 'Abhinkop.kernel-workbench';
const tree = () => process.env.KWB_TREE;

/** The activated extension's parts (activate() returns them for tests). */
async function api() {
	const ext = vscode.extensions.getExtension(ID);
	return ext.isActive ? ext.exports : ext.activate();
}

/** Labels of a tree view's items, one level or two. */
async function labels(provider, element, depth = 1) {
	const out = [];
	for (const item of (await provider.getChildren(element)) || []) {
		const t = await provider.getTreeItem(item);
		out.push(`${t.label}${t.description ? ` — ${t.description}` : ''}`);
		if (depth > 1 && t.collapsibleState)
			out.push(...(await labels(provider, item, depth - 1)).map(l => `  ${l}`));
	}
	return out;
}

/** The child of a tree with that label. */
async function child(provider, label, element) {
	for (const item of (await provider.getChildren(element)) || [])
		if ((await provider.getTreeItem(item)).label === label)
			return item;
	return undefined;
}

function git(...args) {
	return execFileSync('git', args, { cwd: tree(), encoding: 'utf8' });
}

/**
 * Replace a vscode.window prompt for one test, answering from a queue;
 * the extension shares this API object with the tests.
 * @param {'showInputBox'|'showQuickPick'|'showOpenDialog'|'showWarningMessage'|'showInformationMessage'|'showErrorMessage'} name
 * @param {any[]} answers values or functions of the offered items
 */
function answer(name, answers) {
	const orig = vscode.window[name];
	const asked = [];
	vscode.window[name] = async (...args) => {
		asked.push(args);
		const a = answers.length ? answers.shift() : undefined;
		return typeof a === 'function' ? a(await args[0], args) : a;
	};
	return { asked, restore: () => { vscode.window[name] = orig; } };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { ID, tree, api, labels, child, git, answer, sleep, file: (p) => vscode.Uri.file(path.join(tree(), p)) };

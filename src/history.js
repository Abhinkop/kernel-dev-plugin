// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { git, log, fixesLine, relative } = require('./git');
const { SCHEME, blobUri, openCommit } = require('./commits');

/** @typedef {import('./git').Commit} Commit */

const PAGE = 200;

/**
 * @typedef {{ kind: 'file', file: string } | { kind: 'lines', file: string, start: number, end: number }} Target
 *   file is relative to the tree; start/end are 1-based and inclusive
 */

class Item extends vscode.TreeItem {
	/**
	 * @param {string} label
	 * @param {{ commit?: Commit, older?: Commit, file?: string }} [data]
	 */
	constructor(label, data = {}) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.commit = data.commit;
		this.older = data.older;
		this.file = data.file;
	}
}

/**
 * The File History view: every commit that touched the file in the
 * active editor (following renames), or the history of a line range.
 * @implements {vscode.TreeDataProvider<Item>}
 */
class FileHistory {
	/** @param {string} root */
	constructor(root) {
		this.root = root;
		/** @type {Target | undefined} */
		this.target = undefined;
		/** @type {Commit[]} */
		this.commits = [];
		this.filter = '';
		this.loading = false;
		this.more = false;
		this.error = '';
		this.generation = 0;
		/** @type {vscode.CancellationTokenSource | undefined} */
		this.cancel = undefined;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		/** @type {vscode.TreeView<Item> | undefined} */
		this.view = undefined;
	}

	/** @param {vscode.TextEditor | undefined} editor */
	followEditor(editor) {
		if (!editor || editor.document.uri.scheme !== 'file')
			return; // commit tabs, output panels, ... keep the current history
		const file = relative(this.root, editor.document.uri.fsPath);
		if (!file || (this.target?.kind === 'file' && this.target.file === file))
			return;
		this.show({ kind: 'file', file });
	}

	/** @param {Target} target */
	show(target) {
		this.target = target;
		this.filter = '';
		this.reload();
	}

	/** @param {string} filter */
	setFilter(filter) {
		this.filter = filter.trim();
		this.reload();
	}

	reload() {
		this.commits = [];
		this.more = false;
		this.load();
	}

	async load() {
		const target = this.target;
		if (!target)
			return this.refresh();
		this.cancel?.cancel();
		const cancel = this.cancel = new vscode.CancellationTokenSource();
		const generation = ++this.generation;
		this.loading = true;
		this.error = '';
		this.refresh();
		try {
			let commits;
			if (target.kind === 'lines') {
				commits = await log(this.root, ['-s', `-L${target.start},${target.end}:${target.file}`], { cancel: cancel.token });
				this.more = false;
			} else if (this.filter) {
				// --grep (whole message) and --author are ANDed by git; we want either.
				const [bySubject, byAuthor] = await Promise.all([
					log(this.root, ['--follow', '-i', `--grep=${this.filter}`, '-n', '500'], { paths: [target.file], names: true, cancel: cancel.token }),
					log(this.root, ['--follow', '-i', `--author=${this.filter}`, '-n', '500'], { paths: [target.file], names: true, cancel: cancel.token }),
				]);
				const seen = new Set();
				commits = [...bySubject, ...byAuthor]
					.filter(c => !seen.has(c.hash) && seen.add(c.hash))
					.sort((a, b) => b.date.localeCompare(a.date));
				this.more = false;
			} else {
				commits = await log(this.root, ['--follow', '-n', String(PAGE), '--skip', String(this.commits.length)],
					{ paths: [target.file], names: true, cancel: cancel.token });
				this.more = commits.length === PAGE;
			}
			if (generation !== this.generation)
				return;
			this.commits.push(...commits);
		} catch (e) {
			if (generation !== this.generation)
				return;
			this.error = /** @type {Error} */ (e).message;
		}
		this.loading = false;
		this.refresh();
	}

	refresh() {
		if (this.view) {
			const t = this.target;
			this.view.message = !t ? 'Open a file in the kernel tree to see its history.'
				: t.kind === 'lines' ? `Lines ${t.start}–${t.end} of ${t.file}`
				: this.filter ? `${t.file}: matching “${this.filter}”`
				: t.file;
			this.view.description = this.commits.length ? `${this.commits.length}${this.more ? '+' : ''} commits` : '';
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	/** @param {Item} item */
	getTreeItem(item) {
		return item;
	}

	getChildren() {
		const t = this.target;
		if (!t)
			return [];
		/** @type {Item[]} */
		const items = this.commits.map((c, i) => {
			const item = new Item(c.subject, { commit: c, older: this.commits[i + 1], file: c.path || t.file });
			item.description = `${c.short} · ${c.author} · ${c.date.slice(0, 10)}`;
			item.tooltip = new vscode.MarkdownString(
				`**${md(c.subject)}**\n\n${md(c.author)} <${md(c.email)}>  \n${c.date.replace('T', ' ')}  \n\`${c.hash}\`` +
				(c.path && c.path !== t.file ? `  \nfile was ${md(c.path)}` : ''));
			item.iconPath = new vscode.ThemeIcon('git-commit');
			item.contextValue = 'commit';
			item.command = { command: 'kernelDev.git.openCommit', title: 'Open Commit', arguments: [c.hash, item.file] };
			return item;
		});
		if (this.loading) {
			const it = new Item('Loading history…');
			it.iconPath = new vscode.ThemeIcon('loading~spin');
			items.push(it);
		} else if (this.error) {
			const it = new Item(this.error.split('\n')[0]);
			it.iconPath = new vscode.ThemeIcon('error');
			it.tooltip = this.error;
			items.push(it);
		} else if (this.more) {
			const it = new Item(`Load ${PAGE} more…`);
			it.iconPath = new vscode.ThemeIcon('fold-down');
			it.command = { command: 'kernelDev.history.loadMore', title: 'Load more' };
			items.push(it);
		} else if (!this.commits.length) {
			items.push(new Item(this.filter ? 'No matching commits.' : 'No commits (file not tracked?).'));
		}
		return items;
	}
}

/** @param {string} s */
function md(s) {
	return s.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

/**
 * The commit to act on: the tree item a context-menu command was invoked
 * on, or the commit open in the active editor.
 * @param {Item | undefined} item
 */
function commitArg(item) {
	if (item?.commit)
		return item.commit.hash;
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === SCHEME && uri.path.split('/')[1] !== 'blob' ? uri.path.split('/')[2] : undefined;
}

/**
 * Register the File History view and its commands.
 * @param {vscode.ExtensionContext} context
 * @param {string} root
 */
function registerHistory(context, root) {
	const history = new FileHistory(root);
	const view = vscode.window.createTreeView('kernelDev.history', { treeDataProvider: history });
	history.view = view;
	history.followEditor(vscode.window.activeTextEditor);

	/** @param {vscode.Uri | undefined} uri */
	const fileOf = uri => {
		const u = uri || vscode.window.activeTextEditor?.document.uri;
		return u && u.scheme === 'file' ? relative(root, u.fsPath) : undefined;
	};

	/** @type {[string, (...args: any[]) => any][]} */
	const commands = [
		['kernelDev.git.openCommit', (/** @type {string} */ hash, /** @type {string | undefined} */ file) => openCommit(root, hash, { file })],
		['kernelDev.git.commitWhole', (/** @type {vscode.Uri} */ uri) => require('./commits').toggleCommitView(uri || vscode.window.activeTextEditor?.document.uri, false)],
		['kernelDev.git.commitFileOnly', (/** @type {vscode.Uri} */ uri) => require('./commits').toggleCommitView(uri || vscode.window.activeTextEditor?.document.uri, true)],
		['kernelDev.history.showFile', async (/** @type {vscode.Uri | undefined} */ uri) => {
			const file = fileOf(uri);
			if (!file)
				return vscode.window.showWarningMessage('Kernel: open a file inside the kernel tree.');
			history.show({ kind: 'file', file });
			await vscode.commands.executeCommand('kernelDev.history.focus');
		}],
		['kernelDev.history.showLines', async () => {
			const editor = vscode.window.activeTextEditor;
			const file = editor && fileOf(editor.document.uri);
			if (!editor || !file)
				return vscode.window.showWarningMessage('Kernel: select lines in a file inside the kernel tree.');
			if (editor.document.isDirty)
				vscode.window.showWarningMessage('Kernel: the file has unsaved changes; line numbers are matched against the last commit.');
			const sel = editor.selection;
			const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
			history.show({ kind: 'lines', file, start: sel.start.line + 1, end });
			await vscode.commands.executeCommand('kernelDev.history.focus');
		}],
		['kernelDev.history.loadMore', () => history.load()],
		['kernelDev.history.refresh', () => history.reload()],
		['kernelDev.history.filter', async () => {
			const text = await vscode.window.showInputBox({ title: 'Filter history by commit message or author', value: history.filter });
			if (text !== undefined)
				history.setFilter(text);
		}],
		['kernelDev.history.clearFilter', () => history.setFilter('')],
		['kernelDev.git.copyHash', async (/** @type {Item | undefined} */ item) => {
			const hash = commitArg(item);
			if (hash)
				await vscode.env.clipboard.writeText(hash);
		}],
		['kernelDev.git.copyFixes', async (/** @type {Item | undefined} */ item) => {
			const hash = commitArg(item);
			if (!hash)
				return;
			const line = await fixesLine(root, hash);
			await vscode.env.clipboard.writeText(line);
			vscode.window.showInformationMessage(`Copied: ${line}`);
		}],
		['kernelDev.git.openAtCommit', async (/** @type {Item | undefined} */ item) => {
			if (!item?.commit || !item.file)
				return;
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(blobUri(item.commit.hash, item.file)), { preview: false });
		}],
		['kernelDev.git.compareWithPrevious', async (/** @type {Item | undefined} */ item) => {
			if (!item?.commit || !item.file)
				return;
			// The older history entry knows the file's name before a rename.
			const before = item.older?.path || item.file;
			await vscode.commands.executeCommand('vscode.diff',
				blobUri(`${item.commit.hash}^`, before), blobUri(item.commit.hash, item.file),
				`${path.basename(item.file)} (${item.commit.short}^ ↔ ${item.commit.short})`);
		}],
		['kernelDev.git.openOnLore', async (/** @type {Item | undefined} */ item) => {
			const hash = commitArg(item);
			if (hash)
				await openOnLore(root, hash);
		}],
	];
	for (const [id, fn] of commands)
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	context.subscriptions.push(view, vscode.window.onDidChangeActiveTextEditor(e => history.followEditor(e)));
	return history;
}

/**
 * Open the commit's Link: on lore, or search lore for its subject when
 * it has none.
 * @param {string} root @param {string} hash
 */
async function openOnLore(root, hash) {
	const message = await git(root, ['log', '-1', '--format=%B', hash]);
	const links = [...message.matchAll(/^Link:\s*(https?:\/\/\S+)/gim)].map(m => m[1]);
	let url = links.find(l => l.includes('lore.kernel.org')) || links[0];
	if (links.length > 1) {
		const pick = await vscode.window.showQuickPick(links, { title: 'Open which Link:?' });
		if (!pick)
			return;
		url = pick;
	}
	if (!url) {
		const subject = message.split('\n')[0];
		const choice = await vscode.window.showInformationMessage('Kernel: this commit has no Link: tag. Search lore for its subject?', 'Search lore');
		if (!choice)
			return;
		url = `https://lore.kernel.org/all/?q=${encodeURIComponent(`s:"${subject}"`)}`;
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

module.exports = { FileHistory, registerHistory, openOnLore };

// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { git, log, fixesLine, relative } = require('./git');
const { SCHEME, blobUri, openCommit } = require('./commits');
const { openOnLore } = require('./history');

/** @typedef {import('./git').Commit} Commit */

const UNCOMMITTED = /^0{40}$/;

/**
 * One line of git blame --porcelain output.
 * @typedef {Object} BlameLine
 * @property {string} hash
 * @property {number} origLine    line number in that commit's version of the file
 * @property {number} finalLine   line number in the blamed version
 * @property {string} author
 * @property {string} email
 * @property {number} time        seconds since the epoch
 * @property {string} summary
 * @property {string} filename    the file's name in that commit
 * @property {{ hash: string, file: string } | undefined} previous   parent and the file's name there
 * @property {string} text      the line's content
 */

/**
 * @param {string} out git blame --porcelain output
 * @returns {BlameLine[]} indexed by finalLine - 1
 */
function parsePorcelain(out) {
	/** @type {Map<string, any>} */
	const commits = new Map();
	/** @type {BlameLine[]} */
	const lines = [];
	/** @type {any} */
	let cur;
	for (const line of out.split('\n')) {
		const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
		if (head) {
			const info = commits.get(head[1]) || { hash: head[1] };
			commits.set(head[1], info);
			cur = { info, origLine: +head[2], finalLine: +head[3] };
			continue;
		}
		if (!cur)
			continue;
		if (line.startsWith('\t')) {
			const i = cur.info;
			lines[cur.finalLine - 1] = {
				hash: i.hash, origLine: cur.origLine, finalLine: cur.finalLine,
				author: i.author || '', email: (i['author-mail'] || '').replace(/^<|>$/g, ''),
				time: +(i['author-time'] || 0), summary: i.summary || '', filename: i.filename || '',
				previous: i.previous, text: line.slice(1),
			};
			continue;
		}
		const sp = line.indexOf(' ');
		const key = sp < 0 ? line : line.slice(0, sp);
		const value = sp < 0 ? '' : line.slice(sp + 1);
		if (key === 'previous') {
			const [hash, ...file] = value.split(' ');
			cur.info.previous = { hash, file: file.join(' ') };
		} else {
			cur.info[key] = value;
		}
	}
	return lines;
}

/**
 * What to blame: a working-tree file (possibly with unsaved edits) or a
 * file as of a revision (a kernel-git blob tab).
 * @typedef {{ file: string, rev?: string, contents?: string }} BlameSource
 */

/**
 * @param {vscode.TextDocument} doc
 * @param {string} root
 * @returns {BlameSource | undefined}
 */
function sourceOf(doc, root) {
	if (doc.uri.scheme === 'file') {
		const file = relative(root, doc.uri.fsPath);
		return file ? { file, contents: doc.isDirty ? doc.getText() : undefined } : undefined;
	}
	if (doc.uri.scheme === SCHEME) {
		const [, kind, rev, ...rest] = doc.uri.path.split('/');
		return kind === 'blob' ? { file: rest.join('/'), rev } : undefined;
	}
	return undefined;
}

/**
 * @param {string} root
 * @param {BlameSource} src
 * @param {{ line?: number, cancel?: any }} [opts] line: 1-based, blame only that line
 */
async function blame(root, src, opts = {}) {
	const cfg = vscode.workspace.getConfiguration('kernelDev');
	const args = ['blame', '--porcelain'];
	if (cfg.get('blame.ignoreWhitespace', true))
		args.push('-w');
	if (cfg.get('blame.detectMoves', false))
		args.push('-M', '-C');
	if (fs.existsSync(path.join(root, '.git-blame-ignore-revs')))
		args.push('--ignore-revs-file', '.git-blame-ignore-revs');
	if (opts.line)
		args.push('-L', `${opts.line},${opts.line}`);
	if (src.contents !== undefined)
		args.push('--contents', '-');
	if (src.rev)
		args.push(src.rev);
	args.push('--', src.file);
	return parsePorcelain(await git(root, args, { input: src.contents, cancel: opts.cancel }));
}

/** @param {number} t seconds */
function day(t) {
	return t ? new Date(t * 1000).toISOString().slice(0, 10) : '';
}

/**
 * Markdown hover for a blamed line, with command links.
 * @param {BlameLine} b
 * @param {BlameSource} src
 */
function hoverFor(b, src) {
	const md = new vscode.MarkdownString();
	md.isTrusted = true;
	if (UNCOMMITTED.test(b.hash)) {
		md.appendMarkdown('**Not committed yet**');
		return md;
	}
	const cmd = (/** @type {string} */ id, /** @type {any[]} */ args) => `command:${id}?${encodeURIComponent(JSON.stringify(args))}`;
	md.appendMarkdown(`**${escapeMd(b.summary)}**\n\n${escapeMd(b.author)} <${escapeMd(b.email)}> · ${day(b.time)} · \`${b.hash.slice(0, 12)}\`\n\n`);
	md.appendMarkdown(`[Open commit](${cmd('kernelDev.git.openCommit', [b.hash, b.filename])}) · `);
	if (b.previous)
		md.appendMarkdown(`[Blame before this commit](${cmd('kernelDev.blame.before', [b.previous.hash, b.previous.file, b.origLine, b.hash, b.filename])}) · `);
	md.appendMarkdown(`[Copy Fixes: line](${cmd('kernelDev.git.copyFixes', [{ commit: { hash: b.hash } }])})`);
	return md;
}

/** @param {string} s */
function escapeMd(s) {
	return s.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

/**
 * Blame annotations in the editor: hash, author and date before each
 * line, shown once per run of lines from the same commit.
 */
class BlameAnnotations {
	/** @param {string} root */
	constructor(root) {
		this.root = root;
		this.decoration = vscode.window.createTextEditorDecorationType({
			before: {
				color: new vscode.ThemeColor('editorCodeLens.foreground'),
				margin: '0 1.5em 0 0',
				fontStyle: 'normal',
			},
		});
		/** @type {Set<string>} documents with blame turned on */
		this.on = new Set();
		/** @type {Map<string, NodeJS.Timeout>} */
		this.pending = new Map();
	}

	/** @param {vscode.TextEditor} editor */
	async toggle(editor) {
		const key = editor.document.uri.toString();
		if (this.on.has(key)) {
			this.on.delete(key);
			editor.setDecorations(this.decoration, []);
		} else {
			this.on.add(key);
			await this.render(editor);
		}
		vscode.commands.executeCommand('setContext', 'kernelDev.blameOn', this.on.has(key));
	}

	/** @param {vscode.TextEditor} editor */
	isOn(editor) {
		return this.on.has(editor.document.uri.toString());
	}

	/** @param {vscode.TextEditor} editor */
	async render(editor) {
		const src = sourceOf(editor.document, this.root);
		if (!src) {
			vscode.window.showWarningMessage('Kernel: blame works on files in the kernel tree.');
			this.on.delete(editor.document.uri.toString());
			return;
		}
		let lines;
		try {
			lines = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'git blame' },
				() => blame(this.root, src));
		} catch (e) {
			vscode.window.showErrorMessage(`Kernel: git blame failed: ${/** @type {Error} */ (e).message}`);
			this.on.delete(editor.document.uri.toString());
			return;
		}
		if (!this.isOn(editor))
			return;
		const width = 36;
		/** @type {vscode.DecorationOptions[]} */
		const decorations = [];
		let prev = '';
		lines.forEach((b, i) => {
			if (!b)
				return;
			const first = b.hash !== prev;
			prev = b.hash;
			let text = '';
			if (first)
				text = UNCOMMITTED.test(b.hash) ? 'not committed yet'
					: `${b.hash.slice(0, 8)} ${day(b.time)} ${b.author}`;
			text = text.length > width ? text.slice(0, width - 1) + '…' : text.padEnd(width, ' ');
			decorations.push({
				range: new vscode.Range(i, 0, i, 0),
				hoverMessage: hoverFor(b, src),
				renderOptions: { before: { contentText: text } },
			});
		});
		editor.setDecorations(this.decoration, decorations);
	}

	/**
	 * Re-blame after edits (with the unsaved text, so lines stay aligned).
	 * @param {vscode.TextDocument} doc
	 */
	changed(doc) {
		const key = doc.uri.toString();
		if (!this.on.has(key))
			return;
		clearTimeout(this.pending.get(key));
		this.pending.set(key, setTimeout(() => {
			for (const editor of vscode.window.visibleTextEditors)
				if (editor.document.uri.toString() === key)
					this.render(editor);
		}, 800));
	}
}

class Item extends vscode.TreeItem {
	/**
	 * @param {string} label
	 * @param {{ commit?: Commit, line?: BlameLine, children?: Item[] }} [data]
	 */
	constructor(label, data = {}) {
		super(label, data.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		this.commit = data.commit;
		this.line = data.line;
		this.children = data.children;
	}
}

/**
 * The Blame view: for the line under the cursor, the commit that last
 * changed it and the chain of earlier commits that changed it
 * (git log -L), so a whitespace fix or a refactor can be walked past to
 * the commit that introduced the line.
 * @implements {vscode.TreeDataProvider<Item>}
 */
class BlameView {
	/** @param {string} root */
	constructor(root) {
		this.root = root;
		/** @type {{ src: BlameSource, line: number, text: string } | undefined} */
		this.at = undefined;
		/** @type {BlameLine | undefined} */
		this.blamed = undefined;
		/** @type {Commit[] | undefined} */
		this.chain = undefined;
		this.state = 'idle';
		this.error = '';
		this.generation = 0;
		/** @type {vscode.CancellationTokenSource | undefined} */
		this.cancel = undefined;
		/** @type {NodeJS.Timeout | undefined} */
		this.timer = undefined;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		/** @type {vscode.TreeView<Item> | undefined} */
		this.view = undefined;
	}

	/** @param {vscode.TextEditor | undefined} editor */
	follow(editor) {
		if (!editor || !this.view?.visible)
			return;
		const src = sourceOf(editor.document, this.root);
		if (!src)
			return;
		const line = editor.selection.active.line + 1;
		if (this.at && this.at.line === line && this.at.src.file === src.file && this.at.src.rev === src.rev && !src.contents)
			return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.update(src, line, editor.document.lineAt(line - 1).text.trim()), 300);
	}

	/** @param {BlameSource} src @param {number} line @param {string} text */
	async update(src, line, text) {
		this.cancel?.cancel();
		const cancel = this.cancel = new vscode.CancellationTokenSource();
		const generation = ++this.generation;
		this.at = { src, line, text };
		this.blamed = undefined;
		this.chain = undefined;
		this.state = 'blame';
		this.error = '';
		this.refresh();
		try {
			const [b] = (await blame(this.root, src, { line, cancel: cancel.token })).filter(Boolean);
			if (generation !== this.generation)
				return;
			this.blamed = b;
			if (!b || UNCOMMITTED.test(b.hash)) {
				this.chain = [];
			} else {
				this.state = 'chain';
				this.refresh();
				// Follow the line from the commit that last changed it, in
				// that commit's numbering, so unsaved or uncommitted edits
				// above it do not shift the range.
				this.chain = await log(this.root, ['-s', `-L${b.origLine},${b.origLine}:${b.filename}`, b.hash], { cancel: cancel.token });
			}
			if (generation !== this.generation)
				return;
			this.state = 'done';
		} catch (e) {
			if (generation !== this.generation)
				return;
			this.state = 'error';
			this.error = /** @type {Error} */ (e).message;
		}
		this.refresh();
	}

	refresh() {
		if (this.view)
			this.view.message = this.at ? `${this.at.src.rev ? `${this.at.src.rev.slice(0, 12)}:` : ''}${this.at.src.file}:${this.at.line}` : 'Put the cursor on a line of a file in the kernel tree.';
		this._onDidChangeTreeData.fire(undefined);
	}

	/** @param {Item} item */
	getTreeItem(item) {
		return item;
	}

	/** @param {Item} [item] */
	getChildren(item) {
		if (item)
			return item.children || [];
		if (!this.at)
			return [];
		/** @type {Item[]} */
		const items = [];
		const text = new Item(this.at.text || '(empty line)');
		text.iconPath = new vscode.ThemeIcon('symbol-text');
		text.tooltip = this.at.text;
		items.push(text);
		const b = this.blamed;
		if (this.state === 'blame')
			items.push(spinner('Running git blame…'));
		if (b && UNCOMMITTED.test(b.hash)) {
			const it = new Item('Not committed yet');
			it.iconPath = new vscode.ThemeIcon('circle-outline');
			items.push(it);
		} else if (b) {
			/** @type {Commit} */
			const commit = { hash: b.hash, short: b.hash.slice(0, 12), subject: b.summary, author: b.author, email: b.email, date: new Date(b.time * 1000).toISOString(), path: b.filename };
			const last = commitItem(commit, b, 'Last changed in');
			items.push(last);
			if (this.state === 'chain')
				items.push(spinner('Following the line back (git log -L)…'));
			else if (this.chain && this.chain.length) {
				const older = this.chain.slice(1).map(c => commitItem(c, undefined, ''));
				const head = new Item(older.length ? `Earlier changes to this line (${older.length})` : 'No earlier changes: this commit added the line',
					older.length ? { children: older } : {});
				head.iconPath = new vscode.ThemeIcon(older.length ? 'history' : 'star-full');
				head.tooltip = older.length ? 'Oldest last: the bottom one introduced the line' : undefined;
				items.push(head);
			}
		}
		if (this.state === 'error') {
			const it = new Item(this.error.split('\n')[0]);
			it.iconPath = new vscode.ThemeIcon('error');
			it.tooltip = this.error;
			items.push(it);
		}
		return items;
	}
}

/**
 * First line of `file` that `commit` changed, in the parent's numbering.
 * @param {string} root @param {string} commit @param {string} file
 */
async function firstChangedLine(root, commit, file) {
	const m = /^@@ -(\d+)/m.exec(await git(root, ['show', '-U0', '--format=', '--no-color', commit, '--', file]));
	return m ? Math.max(1, +m[1]) : 1;
}

/**
 * Map a line of `file` in `commit` to the corresponding line of `oldFile`
 * in `parent`, through the commit's diff: lines after a hunk shift by
 * what the hunk added or removed, and a line inside a hunk maps to the
 * same position in the hunk's old side.
 * @param {string} root
 * @param {string} parent @param {string} oldFile
 * @param {string} commit @param {string} file
 * @param {number} line 1-based, in `commit`
 */
async function mapToParent(root, parent, oldFile, commit, file, line) {
	const diff = await git(root, ['diff', '-U0', '--no-color', '-M', parent, commit, '--', oldFile, file]);
	let shift = 0;
	for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
		const [oldStart, oldCount, newStart, newCount] = [+m[1], m[2] === undefined ? 1 : +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
		// First line after the hunk on each side. A count of 0 means the
		// hunk sits after line <start> (pure insertion or deletion).
		const oldNext = oldCount ? oldStart + oldCount : oldStart + 1;
		const newNext = newCount ? newStart + newCount : newStart + 1;
		if (line < (newCount ? newStart : newNext))
			break;
		if (line < newNext) // inside the hunk
			return Math.max(1, oldStart + Math.min(line - newStart, Math.max(oldCount - 1, 0)));
		shift = oldNext - newNext;
	}
	return Math.max(1, line + shift);
}

/** @param {string} label */
function spinner(label) {
	const it = new Item(label);
	it.iconPath = new vscode.ThemeIcon('loading~spin');
	return it;
}

/**
 * @param {Commit} c
 * @param {BlameLine | undefined} b
 * @param {string} prefix
 */
function commitItem(c, b, prefix) {
	const it = new Item(c.subject, { commit: c, line: b });
	it.description = `${prefix ? prefix + ' ' : ''}${c.short} · ${c.author} · ${c.date.slice(0, 10)}`;
	it.iconPath = new vscode.ThemeIcon('git-commit');
	it.tooltip = new vscode.MarkdownString(`**${escapeMd(c.subject)}**\n\n${escapeMd(c.author)} · ${c.date.slice(0, 10)} · \`${c.hash}\``);
	it.contextValue = 'blameCommit';
	it.command = { command: 'kernelDev.git.openCommit', title: 'Open Commit', arguments: [c.hash, c.path] };
	return it;
}

/**
 * Register blame annotations, the Blame view and their commands.
 * @param {vscode.ExtensionContext} context
 * @param {string} root
 */
function registerBlame(context, root) {
	const annotations = new BlameAnnotations(root);
	const blameView = new BlameView(root);
	const view = vscode.window.createTreeView('kernelDev.blame', { treeDataProvider: blameView });
	blameView.view = view;

	/**
	 * Re-blame the file as of `rev` in a tab of its own, at `line`: the
	 * kernel way of looking past a cleanup commit.
	 * @param {string} rev @param {string} file @param {number} [line]
	 */
	const blameAt = async (rev, file, line) => {
		const doc = await vscode.workspace.openTextDocument(blobUri(rev, file));
		const editor = await vscode.window.showTextDocument(doc, { preview: false });
		if (line) {
			const pos = new vscode.Position(Math.min(line, doc.lineCount) - 1, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos.line, 0, pos.line, 0), 2 /* InCenter */);
		}
		if (!annotations.isOn(editor))
			await annotations.toggle(editor);
		blameView.follow(editor);
	};

	/** @type {[string, (...args: any[]) => any][]} */
	const commands = [
		['kernelDev.blame.toggle', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor)
				await annotations.toggle(editor);
		}],
		['kernelDev.blame.before', async (/** @type {any} */ a, /** @type {string} */ file, /** @type {number} */ line, /** @type {string} */ text, /** @type {string} */ childFile) => {
			if (typeof a === 'string') // from a hover link: parent, file there, child commit, its file, line in it
				return blameAt(a, file, await mapToParent(root, a, file, text, childFile, line));
			// From the Blame view: the commit's parent, the file's name
			// there and the line's number in it come from blame.
			const item = /** @type {Item} */ (a);
			const b = item?.line;
			if (b?.previous)
				return blameAt(b.previous.hash, b.previous.file,
					await mapToParent(root, b.previous.hash, b.previous.file, b.hash, b.filename, b.origLine));
			if (item?.commit) {
				// An earlier commit in the chain: open the file before it, at
				// the start of what the commit changed in it.
				const c = item.commit;
				const file = c.path || blameView.at?.src.file;
				return file && blameAt(`${c.hash}^`, file, await firstChangedLine(root, c.hash, file));
			}
		}],
		['kernelDev.blame.copyFixes', async (/** @type {Item} */ item) => {
			if (!item?.commit)
				return;
			const line = await fixesLine(root, item.commit.hash);
			await vscode.env.clipboard.writeText(line);
			vscode.window.showInformationMessage(`Copied: ${line}`);
		}],
		['kernelDev.blame.copyHash', (/** @type {Item} */ item) => item?.commit && vscode.env.clipboard.writeText(item.commit.hash)],
		['kernelDev.blame.openOnLore', (/** @type {Item} */ item) => item?.commit && openOnLore(root, item.commit.hash)],
	];
	for (const [id, fn] of commands)
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	context.subscriptions.push(
		view,
		annotations.decoration,
		view.onDidChangeVisibility(() => blameView.follow(vscode.window.activeTextEditor)),
		vscode.window.onDidChangeTextEditorSelection(e => blameView.follow(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(e => {
			vscode.commands.executeCommand('setContext', 'kernelDev.blameOn', !!e && annotations.isOn(e));
			blameView.follow(e);
		}),
		vscode.workspace.onDidChangeTextDocument(e => annotations.changed(e.document)),
		vscode.workspace.onDidSaveTextDocument(d => annotations.changed(d)),
	);
	return { annotations, blameView };
}

module.exports = { parsePorcelain, blame, mapToParent, BlameAnnotations, BlameView, registerBlame };

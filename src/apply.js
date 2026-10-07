// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { git, gitStatus, exists } = require('./git');

/**
 * A series fetched (or loaded) and ready for git am.
 * @typedef {Object} Fetched
 * @property {string} mbox        mbox file to apply
 * @property {string} source      what it came from: a Message-ID or file names
 * @property {string} title
 * @property {string[]} patches   subjects, in order
 * @property {string[]} trailers  trailers b4 added from replies
 * @property {string} [base]      base-commit, when known
 * @property {string} baseNote    b4's account of the base
 * @property {string} [link]
 * @property {string} log         b4's output
 */

/**
 * The state of a git am in progress (.git/rebase-apply).
 * @typedef {{ next: number, last: number, subject: string, conflicts: string[] }} AmState
 */

/** Message-ID from a lore / patch.msgid.link URL or a bare Message-ID. @param {string} input */
function messageId(input) {
	const s = input.trim().replace(/^<|>$/g, '');
	const m = /^https?:\/\/[^/]+\/(?:[^/]+\/)?([^/?#]+@[^/?#]+)/.exec(s);
	return decodeURIComponent(m ? m[1] : s);
}

/** Subjects of the messages in an mbox. @param {string} text */
function mboxSubjects(text) {
	/** @type {string[]} */
	const subjects = [];
	for (const msg of text.split(/^From [^\n]*\n/m).slice(1)) {
		const m = /^Subject: ((?:.*)(?:\n[ \t].*)*)/m.exec(msg);
		if (m)
			subjects.push(m[1].replace(/\n[ \t]+/g, ' ').trim());
	}
	return subjects;
}

class Apply {
	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {string} root
	 */
	constructor(context, root) {
		this.context = context;
		this.root = root;
		/** @type {Fetched | undefined} */
		this.fetched = undefined;
		/** @type {AmState | undefined} */
		this.am = undefined;
		this.busy = '';
		this.message = '';
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChange = this._onDidChange.event;
	}

	changed() {
		this._onDidChange.fire(undefined);
	}

	get gitDir() {
		return path.join(this.root, '.git');
	}

	/**
	 * Fetch a series from lore with b4 am: latest version, patches in
	 * order, trailers from replies collected.
	 * @param {string} input lore link or Message-ID
	 * @param {{ link?: boolean, signoff?: boolean }} [opts]
	 */
	async fetch(input, opts = {}) {
		const msgid = messageId(input);
		if (!/@/.test(msgid))
			return vscode.window.showErrorMessage('Kernel: give a lore link or a Message-ID (it contains an @).');
		const dir = path.join((this.context.storageUri || this.context.globalStorageUri).fsPath, 'lore', msgid.replace(/[^\w.@-]+/g, '_'));
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		const args = ['am', '-o', dir, ...(opts.link !== false ? ['-l'] : []), ...(opts.signoff ? ['-s'] : []), msgid];
		this.busy = `b4 am ${msgid}`;
		this.message = '';
		this.changed();
		try {
			const { code, out } = await run('b4', args, this.root);
			const mbox = fs.readdirSync(dir).find(f => f.endsWith('.mbx'));
			if (code !== 0 || !mbox)
				throw new Error(out.trim().split('\n').slice(-4).join('\n') || `b4 exited with ${code}`);
			this.fetched = parseB4(out, path.join(dir, mbox), msgid);
			// The cover letter's subject names the series.
			const cover = fs.readdirSync(dir).find(f => f.endsWith('.cover'));
			if (cover) {
				const [subject] = mboxSubjects(fs.readFileSync(path.join(dir, cover), 'utf8'));
				if (subject)
					this.fetched.title = subject;
			}
		} catch (e) {
			this.fetched = undefined;
			this.message = `b4 am failed: ${/** @type {Error} */ (e).message}`;
			if (/ENOENT/.test(this.message))
				this.message = 'b4 is not installed (Debian/Ubuntu: sudo apt install b4).';
		} finally {
			this.busy = '';
			this.changed();
		}
	}

	/** Load local .mbox / .patch files instead of fetching. */
	async openFiles() {
		const uris = await vscode.window.showOpenDialog({ title: 'Patches to apply', canSelectMany: true,
			filters: { 'Patches and mailboxes': ['patch', 'diff', 'mbox', 'mbx', 'eml'], 'All files': ['*'] } });
		if (!uris?.length)
			return;
		const files = uris.map(u => u.fsPath).sort();
		const dir = path.join((this.context.storageUri || this.context.globalStorageUri).fsPath, 'local');
		fs.mkdirSync(dir, { recursive: true });
		const mbox = path.join(dir, 'series.mbx');
		// git am takes several files, but one mbox keeps the rest simple;
		// format-patch files already start with a "From <hash>" line.
		fs.writeFileSync(mbox, files.map(f => {
			const t = fs.readFileSync(f, 'utf8');
			return /^From /.test(t) ? t : `From kernel-dev Mon Sep 17 00:00:00 2001\n${t}`;
		}).join('\n'));
		const text = fs.readFileSync(mbox, 'utf8');
		const base = /^base-commit: ([0-9a-f]{7,40})/m.exec(text)?.[1];
		this.fetched = {
			mbox, source: files.map(f => path.basename(f)).join(', '), title: path.basename(files[0]),
			patches: mboxSubjects(text).filter(s => !/\b0+\/\d+\]/.test(s)), trailers: [], log: '',
			base, baseNote: base ? `base-commit ${base.slice(0, 12)} from the patches` : 'not specified',
		};
		if (base && !await exists(this.root, base))
			this.fetched.baseNote += ' (not in this tree)';
		this.message = '';
		this.changed();
	}

	/**
	 * git am -3 the fetched series, on the current branch or on a new
	 * branch at the series' base.
	 * @param {'current'|'newBranch'} where
	 */
	async apply(where) {
		const f = this.fetched;
		if (!f)
			return;
		if (await this.inProgress())
			return vscode.window.showErrorMessage('Kernel: a git am is already in progress; continue, skip or abort it first.');
		if (where === 'newBranch') {
			let base = f.base && await exists(this.root, f.base) ? f.base : undefined;
			if (!base) {
				base = await vscode.window.showInputBox({ title: 'Base for the new branch', prompt: 'The series has no usable base-commit; give a commit or ref', value: 'HEAD' });
				if (!base)
					return;
			}
			const name = await vscode.window.showInputBox({ title: 'New branch name', value: suggestBranch(f) });
			if (!name)
				return;
			const r = await gitStatus(this.root, ['checkout', '-b', name, base]);
			if (r.code !== 0)
				return vscode.window.showErrorMessage(`Kernel: git checkout -b failed: ${r.stderr.trim()}`);
		}
		this.busy = 'git am -3';
		this.changed();
		const r = await gitStatus(this.root, ['am', '-3', f.mbox]);
		this.busy = '';
		await this.refreshState();
		if (r.code === 0) {
			this.message = `Applied ${f.patches.length} patch${f.patches.length > 1 ? 'es' : ''}.`;
		} else {
			this.message = this.am
				? `git am stopped at patch ${this.am.next}/${this.am.last}: ${this.am.subject}`
				: `git am failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`;
			await this.openConflicts();
		}
		this.changed();
	}

	/** @returns {Promise<boolean>} */
	async inProgress() {
		return fs.existsSync(path.join(this.gitDir, 'rebase-apply', 'applying'));
	}

	async refreshState() {
		const dir = path.join(this.gitDir, 'rebase-apply');
		if (!await this.inProgress()) {
			this.am = undefined;
			return this.changed();
		}
		const read = (/** @type {string} */ f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
		const next = +read('next') || 0, last = +read('last') || 0;
		const msg = read('final-commit') || read('msg');
		const conflicts = (await git(this.root, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
		this.am = { next, last, subject: msg.split('\n')[0], conflicts };
		this.changed();
	}

	async openConflicts() {
		for (const f of this.am?.conflicts || [])
			await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, f)), { preview: false });
	}

	/**
	 * git am --continue / --skip / --abort. Continue first stages the
	 * conflicted files once they have no conflict markers left.
	 * @param {'continue'|'skip'|'abort'} what
	 */
	async resolve(what) {
		if (what === 'continue' && this.am?.conflicts.length) {
			const unresolved = this.am.conflicts.filter(f => /^(<{7}|>{7}|={7})( |$)/m.test(readOr(path.join(this.root, f))));
			if (unresolved.length)
				return vscode.window.showErrorMessage(`Kernel: conflict markers left in ${unresolved.join(', ')}.`);
			await git(this.root, ['add', '--', ...this.am.conflicts]);
		}
		const r = await gitStatus(this.root, ['am', `--${what}`]);
		await this.refreshState();
		this.message = r.code === 0
			? (this.am ? `Continuing: now at patch ${this.am.next}/${this.am.last}` : what === 'abort' ? 'git am aborted; the branch is as before.' : 'All patches applied.')
			: `git am --${what}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`;
		if (r.code !== 0 && this.am)
			await this.openConflicts();
		this.changed();
	}
}

/**
 * @param {string} out b4 am output
 * @param {string} mbox
 * @param {string} msgid
 * @returns {Fetched}
 */
function parseB4(out, mbox, msgid) {
	const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
	const patches = [...plain.matchAll(/^\s+(?:\S+ )?(\[[^\]]*PATCH[^\]]*\] .*)$/gm)].map(m => m[1].trim());
	const trailers = [...plain.matchAll(/^\s+\+ (.+?)(?: \(.*\))?$/gm)].map(m => m[1].trim()).filter(t => !/^Link:/.test(t));
	const baseLine = /^\s*Base: (.*)$/m.exec(plain)?.[1].trim() || 'not specified';
	const base = /([0-9a-f]{12,40})/.exec(baseLine)?.[1];
	const link = /^\s*Link: (\S+)/m.exec(plain)?.[1];
	return {
		mbox, source: msgid, title: patches[0] || path.basename(mbox), patches, trailers,
		...(base && !/not known|overriding/.test(baseLine) ? { base } : {}),
		baseNote: baseLine, ...(link ? { link } : {}), log: plain,
	};
}

/** @param {Fetched} f */
function suggestBranch(f) {
	const s = f.title.replace(/^\[[^\]]*\]\s*/, '').replace(/^[\w/.-]+:\s*/, '').toLowerCase();
	return `review/${s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'series'}`;
}

/** @param {string} file */
function readOr(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

/**
 * @param {string} cmd @param {string[]} args @param {string} cwd
 * @returns {Promise<{ code: number, out: string }>}
 */
function run(cmd, args, cwd) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { cwd, maxBuffer: 64 << 20, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
			if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT')
				return reject(err);
			resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` });
		});
	});
}

class Item extends vscode.TreeItem {
	/**
	 * @param {string} label
	 * @param {{ description?: string, icon?: string, color?: string, tooltip?: string | vscode.MarkdownString,
	 *           contextValue?: string, children?: Item[], collapsed?: boolean, command?: vscode.Command,
	 *           option?: import('./kernelView').OptionSpec }} [o]
	 */
	constructor(label, o = {}) {
		super(label, o.children ? (o.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
			: vscode.TreeItemCollapsibleState.None);
		this.description = o.description;
		if (o.icon)
			this.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
		this.tooltip = o.tooltip;
		this.contextValue = o.contextValue;
		this.children = o.children;
		this.option = o.option;
		if (o.command)
			this.command = o.command;
		else if (o.contextValue === 'edit')
			this.command = { command: 'kernelDev.editItem', title: 'Change…', arguments: [this] };
	}
}

/**
 * The Apply view in the Kernel Git tab: the fetched series, and a git am
 * in progress.
 * @implements {vscode.TreeDataProvider<Item>}
 */
class ApplyTree {
	/** @param {Apply} apply @param {import('./settings').Settings} s */
	constructor(apply, s) {
		this.apply = apply;
		this.s = s;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		apply.onDidChange(() => this.refresh());
		s.onDidChange(() => this.refresh());
	}

	refresh() {
		const a = this.apply;
		vscode.commands.executeCommand('setContext', 'kernelDev.applyFetched', !!a.fetched);
		vscode.commands.executeCommand('setContext', 'kernelDev.amInProgress', !!a.am);
		vscode.commands.executeCommand('setContext', 'kernelDev.applyEmpty', !a.fetched && !a.am && !a.busy && !a.message);
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
		const a = this.apply;
		/** @type {Item[]} */
		const items = [];
		if (a.busy)
			items.push(new Item(a.busy, { icon: 'loading~spin' }));
		const act = (/** @type {string} */ label, /** @type {string} */ command, /** @type {string} */ icon, /** @type {string} */ description) =>
			new Item(label, { icon, description, contextValue: 'action', tooltip: `Click to ${label.toLowerCase()}`, command: { command, title: label } });
		if (a.am || a.fetched)
			items.push(new Item('Actions', { icon: 'play-circle', children: a.am ? [
				act('Continue', 'kernelDev.apply.continue', 'debug-continue', 'git am --continue (after resolving)'),
				act('Skip this patch', 'kernelDev.apply.skip', 'debug-step-over', 'git am --skip'),
				act('Abort', 'kernelDev.apply.abort', 'close', 'git am --abort'),
			] : [
				act('Apply to current branch', 'kernelDev.apply.applyCurrent', 'check', 'git am -3'),
				act('Apply on new branch…', 'kernelDev.apply.applyNewBranch', 'git-branch', 'new branch at the base, then git am -3'),
				act('Fetch another series…', 'kernelDev.apply.fetch', 'cloud-download', 'b4 am from lore'),
			] }));
		if (a.am) {
			items.push(new Item(`git am stopped at patch ${a.am.next}/${a.am.last}`, {
				description: a.am.subject, icon: 'warning', color: 'problemsWarningIcon.foreground',
				tooltip: 'Resolve the conflicts, then Continue; or Skip this patch, or Abort.',
				children: a.am.conflicts.length
					? a.am.conflicts.map(f => new Item(f, { icon: 'diff', command: { command: 'vscode.open', title: 'Open',
						arguments: [vscode.Uri.file(path.join(a.root, f))] } }))
					: [new Item('No conflicted files: the patch did not apply at all. Skip it or abort.', { icon: 'info' })],
			}));
		}
		const f = a.fetched;
		if (f) {
			items.push(new Item(f.title.replace(/^\[[^\]]*\]\s*/, ''), {
				description: /^\[([^\]]*)\]/.exec(f.title)?.[1] || '',
				icon: 'git-pull-request', tooltip: `${f.title}\n${f.source}`,
				children: f.patches.map(p => new Item(p.replace(/^\[[^\]]*\]\s*/, ''), { icon: 'git-commit', description: /^\[[^\]]*?(\d+\/\d+)\]/.exec(p)?.[1] || '' })),
			}));
			items.push(new Item('Base', { description: f.baseNote, icon: 'git-branch', tooltip: f.baseNote }));
			items.push(new Item('Trailers collected', {
				description: String(f.trailers.length), icon: 'tag',
				children: f.trailers.map(t => new Item(t, { icon: 'person' })), collapsed: true,
			}));
			items.push(new Item('mbox', { description: path.basename(f.mbox), icon: 'file',
				command: { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(f.mbox)] } }));
		}
		if (a.message)
			items.push(new Item(a.message, { icon: /fail|error|not installed/i.test(a.message) ? 'error' : 'info', tooltip: a.message }));
		if (items.length) {
			/** @type {import('./kernelView').OptionSpec[]} */
			const specs = [
				{ key: 'apply.addLink', label: 'Add Link: trailers', kind: 'bool' },
				{ key: 'apply.addSignoff', label: 'Add my Signed-off-by', kind: 'bool' },
			];
			items.push(new Item('Fetch options', {
				icon: 'settings', collapsed: true,
				children: specs.map(o => new Item(o.label, { description: this.s.get(o.key, o.key === 'apply.addLink') ? 'on' : 'off',
					contextValue: 'edit', option: o, tooltip: `kernelDev.${o.key}` })),
			}));
		}
		return items;
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./settings').Settings} s
 */
function registerApply(context, s) {
	const apply = new Apply(context, s.root);
	const tree = new ApplyTree(apply, s);
	const fetch = async () => {
		const input = await vscode.window.showInputBox({ title: 'Fetch a series from lore', prompt: 'lore link or Message-ID',
			placeHolder: 'https://lore.kernel.org/r/… or 20260917233222.2542500-2-memxor@gmail.com' });
		if (!input)
			return;
		await vscode.commands.executeCommand('kernelDev.apply.focus');
		await apply.fetch(input, { link: s.get('apply.addLink', true), signoff: s.get('apply.addSignoff', false) });
	};
	/** @type {[string, (...args: any[]) => any][]} */
	const commands = [
		['kernelDev.apply.fetch', fetch],
		['kernelDev.apply.openFiles', () => apply.openFiles()],
		['kernelDev.apply.applyCurrent', () => apply.apply('current')],
		['kernelDev.apply.applyNewBranch', () => apply.apply('newBranch')],
		['kernelDev.apply.continue', () => apply.resolve('continue')],
		['kernelDev.apply.skip', () => apply.resolve('skip')],
		['kernelDev.apply.abort', () => apply.resolve('abort')],
		['kernelDev.apply.showLog', async () => {
			if (!apply.fetched)
				return;
			const doc = await vscode.workspace.openTextDocument({ content: apply.fetched.log, language: 'plaintext' });
			await vscode.window.showTextDocument(doc, { preview: true });
		}],
		['kernelDev.apply.openLink', () => apply.fetched?.link && vscode.env.openExternal(vscode.Uri.parse(apply.fetched.link))],
		['kernelDev.apply.clear', () => { apply.fetched = undefined; apply.message = ''; apply.changed(); }],
	];
	const view = vscode.window.createTreeView('kernelDev.apply', { treeDataProvider: tree });
	for (const [id, fn] of commands)
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	context.subscriptions.push(view, view.onDidChangeVisibility(() => view.visible && apply.refreshState()));
	apply.refreshState();
	tree.refresh();
	return { apply, view: tree };
}

module.exports = { Apply, ApplyTree, registerApply, messageId, mboxSubjects, parseB4 };

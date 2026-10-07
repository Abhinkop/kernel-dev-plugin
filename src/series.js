// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, gitStatus, log, exists } = require('./git');
const { openCommit } = require('./commits');
const checkpatch = require('./checkpatch');
const { runTask, sq } = require('./tasks');
const { Patches } = require('./patches');
const { Sender } = require('./send');

/** @typedef {import('./git').Commit} Commit */
/** @typedef {import('./checkpatch').Report} Report */
/** @typedef {import('./settings').Settings} Settings */

/**
 * The series: the commits of the current branch on top of a base, the
 * way they will become a patch series.
 * @typedef {Object} SeriesInfo
 * @property {string} branch      branch name, or '' when HEAD is detached
 * @property {string} [base]      the ref the series is based on
 * @property {string} [mergeBase] where the series starts
 * @property {Commit[]} commits   oldest first, i.e. in patch order
 * @property {string} [error]
 */

const MAX_COMMITS = 200;

class Series {
	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {Settings} s
	 */
	constructor(context, s) {
		this.context = context;
		this.s = s;
		this.root = s.root;
		/** @type {SeriesInfo} */
		this.info = { branch: '', commits: [] };
		/** @type {Map<string, Report>} checkpatch results by commit hash */
		this.reports = new Map();
		/** @type {Report | undefined | null} null: checked, no changes */
		this.working = undefined;
		this.busy = '';
		this.lastBuild = '';
		this.problems = new checkpatch.Problems(this.root);
		/** @type {import('./dt').DtChecks | undefined} set when the devicetree checks are available */
		this.dt = undefined;
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChange = this._onDidChange.event;
	}

	changed() {
		this._onDidChange.fire(undefined);
	}

	/** @param {string} key */
	branchKey(key) {
		return `kernelDev.series.${key}:${this.info.branch || 'HEAD'}`;
	}

	get version() {
		return /** @type {number} */ (this.context.workspaceState.get(this.branchKey('version'), 1));
	}

	/** @param {number} v */
	async setVersion(v) {
		await this.context.workspaceState.update(this.branchKey('version'), Math.max(1, v));
		this.changed();
	}

	/**
	 * The base: one picked for this branch, else the branch's upstream,
	 * else kernelDev.patches.base, if it exists.
	 * @returns {Promise<string | undefined>}
	 */
	async resolveBase() {
		const picked = /** @type {string | undefined} */ (this.context.workspaceState.get(this.branchKey('base')));
		if (picked && await exists(this.root, picked))
			return picked;
		const upstream = await gitStatus(this.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
		if (upstream.code === 0 && upstream.stdout.trim())
			return upstream.stdout.trim();
		const configured = this.s.get('patches.base', 'origin/master');
		if (configured && await exists(this.root, configured))
			return configured;
		return undefined;
	}

	async refresh() {
		const branch = (await gitStatus(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
		this.info = { branch, commits: [] };
		try {
			const base = await this.resolveBase();
			if (!base) {
				this.info.error = `No base: "${this.s.get('patches.base', 'origin/master')}" does not exist here. Pick the commit or ref the series is based on.`;
			} else {
				const mergeBase = (await git(this.root, ['merge-base', base, 'HEAD'])).trim();
				const commits = await log(this.root, ['--reverse', '--no-merges', `${mergeBase}..HEAD`]);
				this.info = { branch, base, mergeBase, commits: commits.slice(-MAX_COMMITS) };
				if (commits.length > MAX_COMMITS)
					this.info.error = `${commits.length} commits on top of ${base}: is that the right base? Showing the last ${MAX_COMMITS}.`;
			}
		} catch (e) {
			this.info.error = /** @type {Error} */ (e).message;
		}
		// Results for commits no longer in the series go away.
		const hashes = new Set(this.info.commits.map(c => c.hash));
		for (const h of [...this.reports.keys()])
			if (!hashes.has(h))
				this.reports.delete(h);
		this.problems.prune(origin => origin === 'working' || hashes.has(origin));
		this.changed();
	}

	async pickBase() {
		const refs = (await git(this.root, ['for-each-ref', '--sort=-committerdate', '--count=200', '--format=%(refname:short)',
			'refs/heads', 'refs/remotes', 'refs/tags'])).split('\n').filter(r => r && !r.endsWith('/HEAD'));
		const enter = '$(edit) Enter a commit or ref…';
		const pick = await vscode.window.showQuickPick([enter, ...refs], { title: 'Base of the series' });
		let base = pick;
		if (pick === enter)
			base = await vscode.window.showInputBox({ title: 'Base commit or ref', prompt: 'e.g. v6.12, origin/master, a commit hash' });
		if (!base)
			return;
		if (!await exists(this.root, base))
			return vscode.window.showErrorMessage(`Kernel: "${base}" is not a commit here.`);
		await this.context.workspaceState.update(this.branchKey('base'), base);
		await this.refresh();
	}

	/** checkpatch on uncommitted changes. */
	async checkWorking() {
		await this.withBusy('checkpatch: working changes', async () => {
			const report = await checkpatch.checkWorkingChanges(this.root);
			this.working = report || null;
			await this.problems.set('working', report ? report.findings : []);
		});
	}

	/**
	 * checkpatch on every commit, then W=1 (and sparse / Coccinelle, if
	 * enabled) on the C files the series and the working tree touch.
	 */
	async checkSeries() {
		await this.refresh();
		const { commits, mergeBase } = this.info;
		if (!mergeBase)
			return vscode.window.showErrorMessage(`Kernel: ${this.info.error || 'no series to check.'}`);
		await this.withBusy(`checkpatch: ${commits.length} commits`, async () => {
			let done = 0;
			const queue = [...commits];
			const worker = async () => {
				for (let c = queue.shift(); c; c = queue.shift()) {
					const report = await checkpatch.checkCommit(this.root, c.hash);
					this.reports.set(c.hash, report);
					await this.problems.set(c.hash, report.findings, c.hash);
					this.busy = `checkpatch: ${++done}/${commits.length}`;
					this.changed();
				}
			};
			await Promise.all([worker(), worker(), worker(), worker()]);
		});
		await this.buildChecks(mergeBase);
	}

	/**
	 * Compile the touched C files with W=1 (and C=2 for sparse) in the
	 * Kernel tab's configured build, with diagnostics in Problems. Single
	 * objects are built even when the file is disabled in .config.
	 * @param {string} mergeBase
	 */
	async buildChecks(mergeBase) {
		const changed = (await git(this.root, ['diff', '--name-only', '--diff-filter=d', mergeBase])).split('\n').filter(Boolean);
		await this.compileChecks(changed);
		// Devicetree sources and bindings, when the series touches them.
		if (this.dt && changed.some(f => /\.dtsi?$/.test(f) || (f.startsWith('Documentation/devicetree/bindings/') && f.endsWith('.yaml')))) {
			this.busy = 'DT check';
			this.changed();
			this.lastBuild += ` · ${await this.dt.check(changed)}`;
			this.busy = '';
			this.changed();
		}
	}

	/** @param {string[]} changed repository-relative files changed since the base */
	async compileChecks(changed) {
		const state = this.s.configured();
		const files = changed.filter(f => /\.c$/.test(f) && !f.startsWith('tools/') && !f.startsWith('scripts/'));
		if (!files.length) {
			this.lastBuild = 'no C files changed';
			return this.changed();
		}
		if (!state) {
			this.lastBuild = 'skipped: configure a build in the Kernel tab for W=1';
			return this.changed();
		}
		const objs = files.map(f => f.replace(/\.c$/, '.o'));
		const sparse = this.s.get('check.sparse', false);
		const extra = ['W=1', ...(sparse ? ['C=2'] : [])];
		const logFile = path.join(os.tmpdir(), `kernel-dev-check-${process.pid}.log`);
		const make = ['make', ...state.makeArgs, this.s.jobs(), '-k', ...extra, ...objs].map(sq).join(' ');
		// The output is kept to count findings and to notice that Kbuild
		// skipped sparse, which it only mentions in passing.
		const code = await runTask(this.s.folder, `Check build ${extra.join(' ')} (${objs.length} files)`, 'bash',
			['-c', `set -o pipefail; ${make} 2>&1 | tee ${sq(logFile)}`], { problemMatcher: ['$gcc'], step: 'check' });
		const out = readAndRemove(logFile);
		const count = (/** @type {RegExp} */ re) => (out.match(re) || []).length;
		const parts = [`${extra.join(' ')} on ${objs.length} file${objs.length > 1 ? 's' : ''}:`];
		const errors = count(/^\S+:\d+:\d+: error:/gm), warnings = count(/^\S+:\d+:\d+: warning:/gm);
		parts.push(errors || warnings ? `${errors} errors, ${warnings} warnings (see Problems)` : code === 0 ? 'clean' : 'build failed (see the terminal)');
		if (sparse && /sparse is not available or not up to date/.test(out))
			parts.push('· sparse was NOT run: it is missing or too old for this kernel (build a current sparse from git.kernel.org)');
		this.lastBuild = parts.join(' ');
		this.changed();

		if (this.s.get('check.coccinelle', false)) {
			// coccicheck with O= scans the build directory instead of M=,
			// and it reports paths relative to M=; run it in the source tree
			// (it writes nothing there) and prefix the directory.
			const arch = state.makeArgs.find(a => a.startsWith('ARCH=')) || '';
			const dirs = [...new Set(files.map(f => path.dirname(f)))];
			const script = ['set -o pipefail', ...dirs.map(d =>
				`make ${sq(arch)} ${this.s.jobs()} coccicheck MODE=report M=${sq(d)} 2>&1 | sed -e ${sq(`s|^[.]/|${d}/|`)}`)].join('\n');
			const cc = await runTask(this.s.folder, `Coccinelle (${dirs.length} dir${dirs.length > 1 ? 's' : ''})`, 'bash', ['-c', script],
				{ problemMatcher: ['$kernel-coccinelle'], step: 'coccinelle' });
			this.lastBuild += ` · Coccinelle: ${cc === 0 ? 'done (see Problems)' : 'failed (see the terminal; it needs ocaml-nox)'}`;
			this.changed();
		}
	}

	/** git clang-format: reformat only the lines changed since the base. */
	async formatChanged() {
		if (!require('./tools').onPath('git-clang-format'))
			return vscode.window.showErrorMessage('Kernel: git clang-format is not installed (Debian/Ubuntu: sudo apt install clang-format).');
		await this.refresh();
		if (!this.info.mergeBase)
			return vscode.window.showErrorMessage(`Kernel: ${this.info.error || 'no base for the series.'}`);
		// git clang-format exits 1 when it changed files.
		await runTask(this.s.folder, 'Format changed lines', 'bash', ['-c', [
			`git clang-format ${sq(this.info.mergeBase)}`,
			'rc=$?',
			'if [ $rc = 1 ]; then echo "==> reformatted the lines above; review with git diff, then amend or fixup"; exit 0; fi',
			'exit $rc',
		].join('\n')], { step: 'format' });
	}

	/** Raw checkpatch output for a commit in an editor tab. @param {string} hash */
	async showReport(hash) {
		const report = hash === 'working' ? this.working : this.reports.get(hash);
		if (!report)
			return;
		const commit = this.info.commits.find(c => c.hash === hash);
		const title = commit ? `checkpatch ${commit.short} ${commit.subject}` : 'checkpatch: working changes';
		const doc = await vscode.workspace.openTextDocument({ content: `${title}\n\n${report.output || 'No problems.\n'}`, language: 'plaintext' });
		await vscode.window.showTextDocument(doc, { preview: true });
	}

	/** @param {string} label @param {() => Promise<any>} fn */
	async withBusy(label, fn) {
		this.busy = label;
		this.changed();
		try {
			await fn();
		} catch (e) {
			vscode.window.showErrorMessage(`Kernel: ${label} failed: ${/** @type {Error} */ (e).message}`);
		} finally {
			this.busy = '';
			this.changed();
		}
	}
}

/** @param {string} file */
function readAndRemove(file) {
	try {
		const text = fs.readFileSync(file, 'utf8');
		fs.rmSync(file, { force: true });
		return text;
	} catch {
		return '';
	}
}

/** @param {Report | undefined | null} r */
function summary(r) {
	if (r === undefined)
		return { text: 'not checked', cls: '' };
	if (r === null)
		return { text: 'no changes', cls: '' };
	const parts = [];
	if (r.errors) parts.push(`${r.errors} error${r.errors > 1 ? 's' : ''}`);
	if (r.warnings) parts.push(`${r.warnings} warning${r.warnings > 1 ? 's' : ''}`);
	if (r.checks) parts.push(`${r.checks} check${r.checks > 1 ? 's' : ''}`);
	return { text: parts.join(', ') || 'clean', cls: r.errors ? 'error' : r.warnings || r.checks ? 'warn' : 'ok' };
}

/** What a click on a value row opens. */
/** @type {Record<string, string>} */
const CLICK = {
	base: 'kernelDev.series.pickBase',
	prefix: 'kernelDev.series.editPrefix',
	cover: 'kernelDev.series.editCover',
	edit: 'kernelDev.editItem',
};

class Item extends vscode.TreeItem {
	/**
	 * @param {string} label
	 * @param {{ description?: string, icon?: string, color?: string, tooltip?: string | vscode.MarkdownString,
	 *           contextValue?: string, children?: Item[], collapsed?: boolean, command?: vscode.Command, id?: string,
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
		if (o.command)
			this.command = o.command;
		else if (o.contextValue && CLICK[o.contextValue])
			this.command = { command: CLICK[o.contextValue], title: label, arguments: [this] };
		/** @type {string | undefined} commit hash, 'working', or a file path */
		this.ref = o.id;
		this.option = o.option;
	}
}

/** Icon and color for a checkpatch result. @param {Report | undefined | null} r */
function statusIcon(r) {
	if (!r)
		return { icon: 'git-commit', color: undefined };
	if (r.errors)
		return { icon: 'error', color: 'problemsErrorIcon.foreground' };
	if (r.warnings || r.checks)
		return { icon: 'warning', color: 'problemsWarningIcon.foreground' };
	return { icon: 'pass', color: 'testing.iconPassed' };
}

/**
 * The Series view in the Kernel Git tab: the branch's commits over its
 * base with their checkpatch results, and what Generate patches will use.
 * @implements {vscode.TreeDataProvider<Item>}
 */
class SeriesTree {
	/** @param {Series} series @param {Patches} patches @param {Sender} sender */
	constructor(series, patches, sender) {
		this.series = series;
		this.patches = patches;
		this.sender = sender;
		this.cover = '';
		/** @type {vscode.TreeView<Item> | undefined} */
		this.view = undefined;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		series.onDidChange(() => this.refresh());
		series.s.onDidChange(() => this.refresh());
	}

	async refresh() {
		const se = this.series;
		this.cover = await this.patches.cover();
		if (!this.sender.smtp)
			await this.sender.checkConfig();
		vscode.commands.executeCommand('setContext', 'kernelDev.seriesNoBase', !se.info.mergeBase);
		vscode.commands.executeCommand('setContext', 'kernelDev.seriesBusy', !!se.busy);
		vscode.commands.executeCommand('setContext', 'kernelDev.patchesGenerated', !!this.patches.output);
		vscode.commands.executeCommand('setContext', 'kernelDev.dryRunOk', this.sender.dryRunCurrent());
		if (this.view) {
			this.view.description = se.info.mergeBase ? `${se.info.branch || 'detached HEAD'} · v${se.version}` : '';
			this.view.message = se.info.mergeBase && se.info.error ? se.info.error : undefined;
		}
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
		const se = this.series;
		if (!se.info.mergeBase)
			return []; // welcome view: pick a base
		/** @type {Item[]} */
		const items = [];
		if (se.busy)
			items.push(new Item(se.busy, { icon: 'loading~spin' }));
		items.push(this.actionsGroup());
		items.push(
			new Item('Base', { description: `${se.info.base} (${se.info.mergeBase.slice(0, 12)})`, icon: 'git-branch', contextValue: 'base' }),
			new Item('Version', { description: `v${se.version}`, icon: 'versions', contextValue: 'version' }),
		);
		const n = se.info.commits.length;
		items.push(new Item('Commits', {
			description: String(n),
			icon: 'git-commit',
			children: n ? se.info.commits.map((c, i) => {
				const r = se.reports.get(c.hash);
				const st = statusIcon(r);
				const notes = r ? r.findings.filter(f => !f.file).map(f => `- ${f.level}: ${f.message}`) : [];
				const tip = new vscode.MarkdownString(`**${md(c.subject)}**\n\n\`${c.short}\` · ${md(c.author)}\n\n` +
					(r ? `checkpatch: ${summary(r).text}${notes.length ? `\n\n${notes.map(md).join('\n')}` : ''}` : 'Not checked yet.'));
				return new Item(c.subject, {
					description: `${i + 1}/${n}${r ? ` · ${summary(r).text}` : ''}`,
					icon: st.icon, color: st.color, tooltip: tip, id: c.hash,
					contextValue: r ? 'commitChecked' : 'commit',
					command: { command: 'kernelDev.git.openCommit', title: 'Open Commit', arguments: [c.hash] },
				});
			}) : [new Item('No commits on top of the base.', { icon: 'info' })],
		}));
		const w = summary(se.working);
		items.push(new Item('Working changes', {
			description: w.text, icon: se.working ? statusIcon(se.working).icon : 'edit',
			color: se.working ? statusIcon(se.working).color : undefined,
			id: 'working', contextValue: se.working ? 'workingChecked' : 'working',
		}));
		if (se.lastBuild)
			items.push(new Item('Build checks', { description: se.lastBuild, tooltip: se.lastBuild, icon: 'tools' }));
		items.push(this.optionsGroup(), this.patchesGroup());
		return items;
	}

	/** What Check series runs; edited like the Kernel view's options. */
	optionsGroup() {
		const s = this.series.s;
		/** @type {import('./kernelView').OptionSpec[]} */
		const specs = [
			{ key: 'checkpatch.strict', label: 'checkpatch --strict', kind: 'bool' },
			{ key: 'checkpatch.ignore', label: 'checkpatch: ignored types', kind: 'words', placeholder: 'FILE_PATH_CHANGES LINUX_VERSION_CODE' },
			{ key: 'check.sparse', label: 'sparse (C=2)', kind: 'bool' },
			{ key: 'check.coccinelle', label: 'Coccinelle', kind: 'bool' },
		];
		return new Item('Check options', {
			icon: 'settings', collapsed: true,
			children: specs.map(o => {
				const v = s.get(o.key, /** @type {any} */ (undefined));
				return new Item(o.label, {
					description: o.kind === 'bool' ? (v ? 'on' : 'off') : (v || []).join(' ') || 'none',
					tooltip: `kernelDev.${o.key}`, contextValue: 'edit', option: o,
				});
			}),
		});
	}

	actionsGroup() {
		const act = (/** @type {string} */ label, /** @type {string} */ command, /** @type {string} */ icon, /** @type {string} */ description) =>
			new Item(label, { icon, description, contextValue: 'action', tooltip: `Click to ${label.toLowerCase()}`, command: { command, title: label } });
		const n = this.series.info.commits.length;
		const children = [
			act('Check series', 'kernelDev.series.check', 'checklist', `checkpatch${n ? ` on ${n} commit${n > 1 ? 's' : ''}` : ''} + build checks`),
			act('Check working changes', 'kernelDev.series.checkWorking', 'edit', 'checkpatch on uncommitted changes'),
			act('Fill recipients', 'kernelDev.series.fillRecipients', 'person-add', 'To/Cc from get_maintainer.pl'),
			act('Generate patches', 'kernelDev.series.generate', 'package', 'git format-patch'),
		];
		if (this.patches.output)
			children.push(act('Dry run', 'kernelDev.series.dryRun', 'debug-alt', 'git send-email --dry-run'));
		if (this.sender.dryRunCurrent())
			children.push(act('Send…', 'kernelDev.series.send', 'send', 'git send-email'));
		return new Item('Actions', { icon: 'play-circle', children });
	}

	patchesGroup() {
		const pa = this.patches;
		const se = this.series;
		/** @type {Item[]} */
		const children = [
			new Item('Subject prefix', { description: `[${pa.prefix}]`, icon: 'symbol-string', contextValue: 'prefix' }),
		];
		if (se.info.commits.length > 1)
			children.push(new Item('Cover letter', {
				description: this.cover ? this.cover.split('\n')[0] : 'not written yet',
				icon: this.cover ? 'mail' : 'warning', color: this.cover ? undefined : 'problemsWarningIcon.foreground',
				contextValue: 'cover', tooltip: this.cover || 'Stored as the git branch description; git format-patch uses it.',
			}));
		const addresses = (/** @type {string[]} */ list) => list.map(a => new Item(a, { icon: 'person' }));
		children.push(
			new Item('To', { description: String(pa.to.length), icon: 'mail', contextValue: 'recipients',
				children: addresses(pa.to), collapsed: true }),
			new Item('Cc', { description: String(pa.cc.length), icon: 'mail', contextValue: 'recipients',
				children: addresses(pa.cc), collapsed: true }),
		);
		if (pa.output) {
			const dir = pa.output.dir;
			const dry = this.sender.dry;
			children.push(new Item('Generated', {
				description: path.relative(se.root, dir),
				icon: 'package', contextValue: 'generated',
				children: pa.output.files.map(f => new Item(f, {
					icon: 'mail', id: path.join(dir, f),
					command: { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(path.join(dir, f))] },
				})),
			}));
			children.push(new Item('Dry run', {
				description: !dry ? 'not run' : !dry.ok ? 'failed' : this.sender.dryRunCurrent() ? `OK, ${dry.mails.length} mails` : 'outdated: the files changed',
				icon: dry?.ok && this.sender.dryRunCurrent() ? 'pass' : dry ? 'warning' : 'circle-large-outline',
				tooltip: `SMTP: ${this.sender.smtp}`,
			}));
		}
		return new Item('Patches', { icon: 'git-pull-request', children });
	}
}

/** @param {string} s */
function md(s) {
	return s.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

/**
 * Register the Series view and its commands.
 * @param {vscode.ExtensionContext} context
 * @param {Settings} s
 */
function registerSeries(context, s) {
	const series = new Series(context, s);
	const patches = new Patches(series);
	const sender = new Sender(patches);
	const tree = new SeriesTree(series, patches, sender);
	const view = vscode.window.createTreeView('kernelDev.series', { treeDataProvider: tree });
	tree.view = view;
	/** @type {[string, (...args: any[]) => any][]} */
	const commands = [
		['kernelDev.series.refresh', () => series.refresh()],
		['kernelDev.series.checkWorking', () => series.checkWorking()],
		['kernelDev.series.check', () => series.checkSeries()],
		['kernelDev.series.format', () => series.formatChanged()],
		['kernelDev.series.pickBase', () => series.pickBase()],
		['kernelDev.series.nextVersion', () => series.setVersion(series.version + 1)],
		['kernelDev.series.previousVersion', () => series.setVersion(series.version - 1)],
		['kernelDev.series.editCover', () => patches.editCover()],
		['kernelDev.series.editPrefix', () => patches.editPrefix()],
		['kernelDev.series.editRecipients', () => patches.editRecipients()],
		['kernelDev.series.fillRecipients', () => series.withBusy('get_maintainer.pl', () => patches.fillRecipients())],
		['kernelDev.series.generate', () => patches.generate()],
		['kernelDev.series.dryRun', () => series.withBusy('git send-email --dry-run', () => sender.dryRun())],
		['kernelDev.series.send', () => sender.send()],
		['kernelDev.series.report', (/** @type {Item} */ item) => item?.ref && series.showReport(item.ref)],
		['kernelDev.series.revealOutput', () => patches.output && vscode.commands.executeCommand('revealFileInOS',
			vscode.Uri.file(path.join(patches.output.dir, patches.output.files[0])))],
	];
	for (const [id, fn] of commands)
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	context.subscriptions.push(view, series.problems.collection,
		view.onDidChangeVisibility(() => view.visible && series.refresh()));
	series.refresh();
	return { series, patches, sender, view: tree };
}

module.exports = { Series, SeriesTree, registerSeries, summary, statusIcon };

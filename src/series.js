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
const { page } = require('./webview');
const { Patches } = require('./patches');

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
		const state = this.s.configured();
		const files = (await git(this.root, ['diff', '--name-only', '--diff-filter=d', mergeBase]))
			.split('\n').filter(f => /\.c$/.test(f) && !f.startsWith('tools/') && !f.startsWith('scripts/'));
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

/**
 * The Series view in the Kernel Git tab.
 * @implements {vscode.WebviewViewProvider}
 */
class SeriesView {
	/** @param {Series} series @param {Patches} patches */
	constructor(series, patches) {
		this.series = series;
		this.patches = patches;
		/** @type {vscode.WebviewView | undefined} */
		this.view = undefined;
		series.onDidChange(() => this.push());
	}

	/** @param {vscode.WebviewView} view */
	resolveWebviewView(view) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = html();
		view.webview.onDidReceiveMessage(m => this.onMessage(m));
		view.onDidChangeVisibility(() => view.visible && this.series.refresh());
		this.series.refresh();
	}

	/** @param {any} m */
	async onMessage(m) {
		const se = this.series;
		if (m.type === 'ready')
			return this.push();
		if (m.type === 'series-option') {
			const value = m.key === 'prefix' ? String(m.value).trim() || 'PATCH'
				: String(m.value).split('\n').map(a => a.trim()).filter(Boolean);
			return this.patches.set(m.key, value);
		}
		if (m.type === 'option') {
			const cfg = vscode.workspace.getConfiguration('kernelDev');
			const value = m.key === 'checkpatch.ignore' ? String(m.value).split(/[\s,]+/).filter(Boolean) : m.value;
			return cfg.update(m.key, value, vscode.ConfigurationTarget.Global).then(() => this.push());
		}
		if (m.type !== 'command')
			return;
		switch (m.command) {
		case 'refresh': return se.refresh();
		case 'pickBase': return se.pickBase();
		case 'versionUp': return se.setVersion(se.version + 1);
		case 'versionDown': return se.setVersion(se.version - 1);
		case 'checkWorking': return se.checkWorking();
		case 'checkSeries': return se.checkSeries();
		case 'format': return se.formatChanged();
		case 'openCommit': return openCommit(se.root, m.arg);
		case 'report': return se.showReport(m.arg);
		case 'editCover': return this.patches.editCover();
		case 'fillRecipients': return se.withBusy('get_maintainer.pl', () => this.patches.fillRecipients());
		case 'generate': return this.patches.generate();
		case 'openPatch': return this.patches.output && vscode.window.showTextDocument(vscode.Uri.file(path.join(this.patches.output.dir, m.arg)), { preview: true });
		case 'revealOutput': return this.patches.output && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(this.patches.output.dir, this.patches.output.files[0])));
		default: return vscode.commands.executeCommand(m.command);
		}
	}

	async push() {
		if (!this.view?.visible)
			return;
		const se = this.series;
		const pa = this.patches;
		const cover = await pa.cover();
		const cfg = vscode.workspace.getConfiguration('kernelDev');
		this.view.webview.postMessage({
			type: 'state',
			branch: se.info.branch || '(detached HEAD)',
			base: se.info.base || '',
			mergeBase: se.info.mergeBase ? se.info.mergeBase.slice(0, 12) : '',
			error: se.info.error || '',
			version: se.version,
			busy: se.busy,
			lastBuild: se.lastBuild,
			working: summary(se.working),
			commits: se.info.commits.map(c => {
				const r = se.reports.get(c.hash);
				return {
					hash: c.hash, short: c.short, subject: c.subject, status: summary(r),
					checked: !!r,
					notes: r ? r.findings.filter(f => !f.file).map(f => `${f.level}: ${f.message}`) : [],
				};
			}),
			prefix: pa.prefix,
			to: pa.to.join('\n'),
			cc: pa.cc.join('\n'),
			coverSubject: cover ? cover.split('\n')[0] : '',
			multi: se.info.commits.length > 1,
			outputDir: path.relative(se.root, pa.outputDir()),
			output: pa.output ? { dir: path.relative(se.root, pa.output.dir), files: pa.output.files } : undefined,
			options: {
				'checkpatch.strict': cfg.get('checkpatch.strict', false),
				'checkpatch.ignore': /** @type {string[]} */ (cfg.get('checkpatch.ignore', [])).join(' '),
				'check.sparse': cfg.get('check.sparse', false),
				'check.coccinelle': cfg.get('check.coccinelle', false),
			},
		});
	}
}

function html() {
	return page(`
	<h3>Series</h3>
	<dl class="status">
		<dt>Branch</dt><dd id="branch"></dd>
		<dt>Base</dt><dd><span id="base"></span> <a data-cmd="pickBase">change…</a></dd>
		<dt>Version</dt><dd><span id="version" class="mono"></span>
			<a data-cmd="versionDown" title="Previous version">−</a> <a data-cmd="versionUp" title="Next version">+</a></dd>
	</dl>
	<p id="error" class="error"></p>
	<ul id="commits" class="list"></ul>
	<div class="tools"><button class="secondary" data-cmd="refresh">Refresh</button></div>

	<h3>Checks</h3>
	<div class="steps">
		<button data-cmd="checkWorking" title="checkpatch on uncommitted changes">Check working changes</button>
		<button data-cmd="checkSeries" title="checkpatch on every commit, then W=1 on the touched C files">Check series</button>
	</div>
	<dl class="status">
		<dt>Now</dt><dd id="busy"></dd>
		<dt>Working</dt><dd><a id="working" data-cmd="report" data-arg="working"></a></dd>
		<dt>Build</dt><dd id="lastBuild"></dd>
	</dl>
	<label class="check"><input type="checkbox" id="strict" data-opt="checkpatch.strict"> checkpatch --strict</label>
	<label for="ignore">checkpatch: ignore types</label>
	<input id="ignore" data-opt="checkpatch.ignore" placeholder="e.g. LINUX_VERSION_CODE FILE_PATH_CHANGES">
	<label class="check"><input type="checkbox" id="sparse" data-opt="check.sparse"> sparse (C=2)</label>
	<label class="check"><input type="checkbox" id="cocci" data-opt="check.coccinelle"> Coccinelle (coccicheck)</label>
	<div class="tools"><button class="secondary" data-cmd="format" title="git clang-format against the base: only changed lines">Format changed lines</button></div>
	<p class="hint">Findings are in the Problems panel. W=1 uses the build configured in the Kernel tab.</p>

	<h3>Patches</h3>
	<label for="prefix">Subject prefix</label>
	<input id="prefix" data-sopt="prefix" placeholder="PATCH, PATCH net-next, RFC PATCH">
	<div id="coverRow">
		<label>Cover letter</label>
		<div class="row"><span id="coverSubject" class="grow"></span><button class="secondary fit" data-cmd="editCover">Edit…</button></div>
	</div>
	<label for="to">To</label>
	<textarea id="to" data-sopt="to" placeholder="one address per line"></textarea>
	<label for="cc">Cc</label>
	<textarea id="cc" data-sopt="cc" placeholder="one address per line"></textarea>
	<div class="tools"><button class="secondary" data-cmd="fillRecipients" title="scripts/get_maintainer.pl: maintainers and reviewers to To, lists to Cc">Fill from get_maintainer.pl</button></div>
	<div class="steps" style="grid-template-columns: 1fr">
		<button data-cmd="generate" id="generate">Generate patches</button>
	</div>
	<p class="hint">Into <span id="outputDir" class="mono"></span>. Blocked while checkpatch reports errors, unless you choose to generate anyway.</p>
	<div id="outputBox">
		<label>Generated <a data-cmd="revealOutput">(open folder)</a></label>
		<ul id="output" class="list"></ul>
	</div>
`, `
	document.querySelectorAll('[data-sopt]').forEach(el => el.addEventListener('change', () =>
		vscode.postMessage({ type: 'series-option', key: el.dataset.sopt, value: el.value })));
	document.querySelectorAll('[data-opt]').forEach(el => el.addEventListener('change', () =>
		vscode.postMessage({ type: 'option', key: el.dataset.opt, value: el.type === 'checkbox' ? el.checked : el.value })));
	window.addEventListener('message', ({ data: st }) => {
		if (st.type !== 'state') return;
		$('branch').textContent = st.branch;
		$('base').textContent = st.base ? st.base + (st.mergeBase ? ' (' + st.mergeBase + ')' : '') : 'none';
		$('version').textContent = 'v' + st.version;
		$('error').textContent = st.error;
		$('busy').textContent = st.busy || 'idle';
		$('busy').className = st.busy ? 'busy' : '';
		$('working').textContent = st.working.text;
		$('working').className = st.working.cls;
		$('lastBuild').textContent = st.lastBuild || '—';
		$('commits').innerHTML = st.commits.length ? st.commits.map((c, i) =>
			'<li data-cmd="openCommit" data-arg="' + c.hash + '" title="' + esc(c.subject) + (c.notes.length ? '\\n\\n' + esc(c.notes.join('\\n')) : '') + '">' +
			'<span class="mono">' + (i + 1) + '/' + st.commits.length + '</span>' +
			'<span class="grow">' + esc(c.subject) + '</span>' +
			(c.checked ? '<a class="' + c.status.cls + '" data-cmd="report" data-arg="' + c.hash + '">' + esc(c.status.text) + '</a>' : '') +
			'</li>').join('') : '<li>No commits on top of the base.</li>';
		document.querySelectorAll('.steps button').forEach(b => b.disabled = !!st.busy);
		$('coverRow').style.display = st.multi ? '' : 'none';
		$('coverSubject').textContent = st.coverSubject || 'not written yet';
		$('coverSubject').className = 'grow' + (st.coverSubject ? '' : ' warn');
		$('outputDir').textContent = st.outputDir;
		$('outputBox').style.display = st.output ? '' : 'none';
		if (st.output) $('output').innerHTML = st.output.files.map(f =>
			'<li data-cmd="openPatch" data-arg="' + esc(f) + '"><span class="grow mono">' + esc(f) + '</span></li>').join('');
		for (const [id, key] of [['prefix', 'prefix'], ['to', 'to'], ['cc', 'cc']])
			if (document.activeElement !== $(id)) $(id).value = st[key];
		for (const el of document.querySelectorAll('[data-opt]')) {
			if (document.activeElement === el) continue;
			if (el.type === 'checkbox') el.checked = !!st.options[el.dataset.opt];
			else el.value = st.options[el.dataset.opt];
		}
	});
	vscode.postMessage({ type: 'ready' });
`);
}

/**
 * Register the Series view.
 * @param {vscode.ExtensionContext} context
 * @param {Settings} s
 */
function registerSeries(context, s) {
	const series = new Series(context, s);
	const patches = new Patches(series);
	const view = new SeriesView(series, patches);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('kernelDev.series', view, { webviewOptions: { retainContextWhenHidden: true } }),
		series.problems.collection,
		vscode.commands.registerCommand('kernelDev.series.checkWorking', () => series.checkWorking()),
		vscode.commands.registerCommand('kernelDev.series.check', () => series.checkSeries()),
		vscode.commands.registerCommand('kernelDev.series.format', () => series.formatChanged()),
		vscode.commands.registerCommand('kernelDev.series.pickBase', () => series.pickBase()),
		vscode.commands.registerCommand('kernelDev.series.editCover', () => patches.editCover()),
		vscode.commands.registerCommand('kernelDev.series.generate', () => patches.generate()),
	);
	return { series, patches, view };
}

module.exports = { Series, SeriesView, registerSeries, html, summary };

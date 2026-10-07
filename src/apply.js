// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { git, gitStatus, exists } = require('./git');
const { page } = require('./webview');

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

/**
 * The Apply view in the Kernel Git tab.
 * @implements {vscode.WebviewViewProvider}
 */
class ApplyView {
	/** @param {Apply} apply */
	constructor(apply) {
		this.apply = apply;
		/** @type {vscode.WebviewView | undefined} */
		this.view = undefined;
		apply.onDidChange(() => this.push());
	}

	/** @param {vscode.WebviewView} view */
	resolveWebviewView(view) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = html();
		view.webview.onDidReceiveMessage(m => this.onMessage(m));
		view.onDidChangeVisibility(() => view.visible && this.apply.refreshState());
		this.apply.refreshState();
	}

	/** @param {any} m */
	async onMessage(m) {
		const a = this.apply;
		if (m.type === 'ready')
			return this.push();
		if (m.type === 'fetch')
			return a.fetch(m.input, { link: m.link, signoff: m.signoff });
		if (m.type !== 'command')
			return;
		switch (m.command) {
		case 'openFiles': return a.openFiles();
		case 'applyCurrent': return a.apply('current');
		case 'applyNew': return a.apply('newBranch');
		case 'continue': case 'skip': case 'abort': return a.resolve(m.command);
		case 'openMbox': return a.fetched && vscode.window.showTextDocument(vscode.Uri.file(a.fetched.mbox), { preview: true });
		case 'openLink': return a.fetched?.link && vscode.env.openExternal(vscode.Uri.parse(a.fetched.link));
		case 'showLog': {
			if (!a.fetched)
				return;
			const doc = await vscode.workspace.openTextDocument({ content: a.fetched.log, language: 'plaintext' });
			return vscode.window.showTextDocument(doc, { preview: true });
		}
		}
	}

	push() {
		if (!this.view?.visible)
			return;
		const a = this.apply;
		this.view.webview.postMessage({ type: 'state', fetched: a.fetched && { ...a.fetched, log: undefined }, am: a.am, busy: a.busy, message: a.message });
	}
}

function html() {
	return page(`
	<h3>Fetch from lore</h3>
	<label for="input">lore link or Message-ID</label>
	<div class="row"><input id="input" placeholder="https://lore.kernel.org/r/… or 2026…@kernel.org"><button class="fit" id="fetch">Fetch</button></div>
	<label class="check"><input type="checkbox" id="link" checked> Add Link: trailers</label>
	<label class="check"><input type="checkbox" id="signoff"> Add my Signed-off-by</label>
	<div class="tools"><button class="secondary" data-cmd="openFiles">Open mbox / patch files…</button></div>
	<p id="busy" class="busy"></p>

	<div id="seriesBox">
		<h3>Series</h3>
		<p id="title"></p>
		<ul id="patches" class="list"></ul>
		<dl class="status">
			<dt>Base</dt><dd id="base"></dd>
			<dt>Trailers</dt><dd id="trailers"></dd>
		</dl>
		<div class="tools">
			<button class="secondary" data-cmd="openMbox">Open mbox</button>
			<button class="secondary" data-cmd="showLog" id="logBtn">b4 output</button>
			<button class="secondary" data-cmd="openLink" id="linkBtn">Open on lore</button>
		</div>
		<div class="steps">
			<button data-cmd="applyCurrent" title="git am -3 on the current branch">Apply to current branch</button>
			<button data-cmd="applyNew" title="git checkout -b at the series' base, then git am -3">Apply on new branch</button>
		</div>
	</div>

	<div id="amBox">
		<h3>git am in progress</h3>
		<p id="amState" class="warn"></p>
		<ul id="conflicts" class="list"></ul>
		<div class="tools">
			<button data-cmd="continue" title="Stage the resolved files and git am --continue">Continue</button>
			<button class="secondary" data-cmd="skip">Skip patch</button>
			<button class="secondary" data-cmd="abort">Abort</button>
		</div>
	</div>
	<p id="message"></p>
`, `
	const fetch = () => vscode.postMessage({ type: 'fetch', input: $('input').value, link: $('link').checked, signoff: $('signoff').checked });
	$('fetch').addEventListener('click', fetch);
	$('input').addEventListener('keydown', e => { if (e.key === 'Enter') fetch(); });
	window.addEventListener('message', ({ data: st }) => {
		if (st.type !== 'state') return;
		$('busy').textContent = st.busy ? st.busy + '…' : '';
		$('fetch').disabled = !!st.busy;
		const f = st.fetched;
		$('seriesBox').style.display = f ? '' : 'none';
		if (f) {
			$('title').textContent = f.title;
			$('patches').innerHTML = f.patches.map(p => '<li><span class="grow">' + esc(p) + '</span></li>').join('');
			$('base').textContent = f.baseNote;
			$('trailers').textContent = f.trailers.length ? f.trailers.length + ' collected from replies' : 'none collected';
			$('trailers').title = f.trailers.join('\\n');
			$('linkBtn').style.display = f.link ? '' : 'none';
		}
		$('amBox').style.display = st.am ? '' : 'none';
		document.querySelectorAll('.steps button').forEach(b => b.disabled = !!st.busy || !!st.am);
		if (st.am) {
			$('amState').textContent = 'Stopped at patch ' + st.am.next + '/' + st.am.last + ': ' + st.am.subject;
			$('conflicts').innerHTML = st.am.conflicts.length
				? st.am.conflicts.map(c => '<li><span class="grow mono">' + esc(c) + '</span></li>').join('')
				: '<li>No conflicted files: the patch did not apply at all. Skip it, or abort.</li>';
		}
		$('message').textContent = st.message;
	});
	vscode.postMessage({ type: 'ready' });
`);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} root
 */
function registerApply(context, root) {
	const apply = new Apply(context, root);
	const view = new ApplyView(apply);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('kernelDev.apply', view, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('kernelDev.apply.fetch', async () => {
			const input = await vscode.window.showInputBox({ title: 'Fetch a series from lore', prompt: 'lore link or Message-ID' });
			if (input)
				await apply.fetch(input);
			await vscode.commands.executeCommand('kernelDev.apply.focus');
		}),
		vscode.commands.registerCommand('kernelDev.apply.openFiles', () => apply.openFiles()),
	);
	return { apply, view };
}

module.exports = { Apply, ApplyView, registerApply, messageId, mboxSubjects, parseB4, html };

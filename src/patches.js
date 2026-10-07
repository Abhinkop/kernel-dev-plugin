// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { git, gitStatus } = require('./git');
const checkpatch = require('./checkpatch');

/** @typedef {import('./series').Series} Series */

const COVER_TEMPLATE = `Subject of the series: what it does, in one line

Why the series is needed and how it is put together. The first paragraph
above is the cover letter's subject; this text is its body. git
format-patch adds the shortlog and the diffstat below it.
`;

/**
 * Patch generation for a Series: the cover letter (kept as the git
 * branch description, which git format-patch reads natively), the
 * recipients from get_maintainer.pl, and git format-patch itself.
 */
class Patches {
	/** @param {Series} series */
	constructor(series) {
		this.series = series;
		this.root = series.root;
		/** @type {{ dir: string, files: string[] } | undefined} */
		this.output = undefined;
		/** Cover letter files being edited: path -> branch. */
		this.editing = new Map();
		series.context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(d => this.saved(d)));
	}

	get branch() {
		return this.series.info.branch;
	}

	/** @param {string} key @param {any} fallback */
	get(key, fallback) {
		return this.series.context.workspaceState.get(this.series.branchKey(key), fallback);
	}

	/** @param {string} key @param {any} value */
	async set(key, value) {
		await this.series.context.workspaceState.update(this.series.branchKey(key), value);
		this.series.changed();
	}

	/** @returns {string[]} */
	get to() { return this.get('to', []); }
	/** @returns {string[]} */
	get cc() { return this.get('cc', []); }
	/** @returns {string} */
	get prefix() { return this.get('prefix', 'PATCH'); }

	/** The cover letter text (branch description), or '' if none. */
	async cover() {
		if (!this.branch)
			return '';
		return (await gitStatus(this.root, ['config', '--get', `branch.${this.branch}.description`])).stdout.replace(/\n+$/, '');
	}

	/**
	 * Edit the cover letter in an editor tab; saving it stores it as the
	 * branch description.
	 */
	async editCover() {
		if (!this.branch)
			return vscode.window.showErrorMessage('Kernel: HEAD is detached; the cover letter is kept per branch.');
		const dir = (this.series.context.storageUri || this.series.context.globalStorageUri).fsPath;
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `cover-letter-${this.branch.replace(/[^\w.-]+/g, '_')}.txt`);
		fs.writeFileSync(file, `${(await this.cover()) || COVER_TEMPLATE.trimEnd()}\n`);
		this.editing.set(file, this.branch);
		await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
		vscode.window.showInformationMessage(`Kernel: save to store the cover letter of "${this.branch}". The first paragraph is the subject.`);
	}

	/** @param {vscode.TextDocument} doc */
	async saved(doc) {
		const branch = this.editing.get(doc.uri.fsPath);
		if (!branch)
			return;
		const text = doc.getText().replace(/\s+$/, '');
		await git(this.root, ['config', `branch.${branch}.description`, text]);
		this.series.changed();
	}

	/**
	 * To/Cc from scripts/get_maintainer.pl on the series: maintainers and
	 * reviewers go to To, mailing lists and everyone else to Cc.
	 */
	async fillRecipients() {
		const { mergeBase, commits } = this.series.info;
		if (!mergeBase || !commits.length)
			return vscode.window.showErrorMessage('Kernel: no commits in the series.');
		const mbox = await git(this.root, ['format-patch', '--stdout', `${mergeBase}..HEAD`]);
		const out = await new Promise((resolve, reject) => {
			const child = execFile('perl', [path.join(this.root, 'scripts', 'get_maintainer.pl')], { cwd: this.root, maxBuffer: 16 << 20 },
				(err, stdout, stderr) => err && !stdout ? reject(new Error(stderr || err.message)) : resolve(stdout));
			child.stdin?.end(mbox);
		});
		const { to, cc } = splitRecipients(/** @type {string} */ (out));
		await this.set('to', to);
		await this.set('cc', cc);
	}

	/**
	 * git format-patch into the output directory. Blocked while checkpatch
	 * reports errors, unless the user says to generate anyway.
	 */
	async generate() {
		const se = this.series;
		await se.refresh();
		const { mergeBase, commits } = se.info;
		if (!mergeBase || !commits.length)
			return vscode.window.showErrorMessage(`Kernel: ${se.info.error || 'no commits in the series.'}`);

		// Make sure every commit has a current checkpatch result.
		if (commits.some(c => !se.reports.has(c.hash))) {
			await se.withBusy('checkpatch before generating', async () => {
				for (const c of commits.filter(c => !se.reports.has(c.hash))) {
					const r = await checkpatch.checkCommit(this.root, c.hash);
					se.reports.set(c.hash, r);
					await se.problems.set(c.hash, r.findings, c.hash);
				}
			});
		}
		const failing = commits.filter(c => (se.reports.get(c.hash)?.errors || 0) > 0);
		if (failing.length) {
			const errors = failing.reduce((n, c) => n + (se.reports.get(c.hash)?.errors || 0), 0);
			const pick = await vscode.window.showWarningMessage(
				`checkpatch reports ${errors} error${errors > 1 ? 's' : ''} in ${failing.length} of ${commits.length} commits.`,
				{ modal: true, detail: failing.map(c => `${c.short} ${c.subject}`).join('\n') }, 'Generate Anyway');
			if (pick !== 'Generate Anyway')
				return;
		}

		const multi = commits.length > 1;
		const cover = await this.cover();
		if (multi && (!cover || cover.startsWith(COVER_TEMPLATE.split('\n')[0]))) {
			const pick = await vscode.window.showWarningMessage('The cover letter has not been written yet.',
				{ modal: true, detail: 'A series of more than one patch gets a cover letter. Without text it is sent with "*** SUBJECT HERE ***".' },
				'Edit Cover Letter', 'Generate Anyway');
			if (pick === 'Edit Cover Letter')
				return this.editCover();
			if (pick !== 'Generate Anyway')
				return;
		}

		const dir = this.outputDir();
		const old = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.patch')) : [];
		if (old.length) {
			const pick = await vscode.window.showWarningMessage(`${path.relative(this.root, dir)} already has ${old.length} patch files.`,
				{ modal: true }, 'Replace Them');
			if (pick !== 'Replace Them')
				return;
			for (const f of old)
				fs.rmSync(path.join(dir, f));
		}
		fs.mkdirSync(dir, { recursive: true });

		const args = ['format-patch', '-o', dir, `--base=${mergeBase}`, `--subject-prefix=${this.prefix}`];
		if (se.version > 1)
			args.push(`-v${se.version}`);
		if (multi)
			args.push('--cover-letter', '--cover-from-description=subject');
		for (const a of this.to) args.push(`--to=${a}`);
		for (const a of this.cc) args.push(`--cc=${a}`);
		args.push(`${mergeBase}..HEAD`);
		let out;
		try {
			out = await git(this.root, args);
		} catch (e) {
			return vscode.window.showErrorMessage(`Kernel: git format-patch failed: ${/** @type {Error} */ (e).message}`);
		}
		const files = out.split('\n').filter(Boolean).map(f => path.basename(f));
		this.output = { dir, files };
		se.changed();
		const first = path.join(dir, files[0]);
		await vscode.window.showTextDocument(vscode.Uri.file(first), { preview: true });
		vscode.window.showInformationMessage(`Kernel: ${files.length} patch file${files.length > 1 ? 's' : ''} in ${path.relative(this.root, dir)}.`);
	}

	outputDir() {
		const tmpl = this.series.s.get('patches.outputDirectory', 'patches/${branch}/v${version}');
		const branch = (this.branch || 'detached').replace(/[^\w.-]+/g, '_');
		return path.resolve(this.root, tmpl.replace(/\$\{branch\}/g, branch).replace(/\$\{version\}/g, String(this.series.version)));
	}
}

/**
 * Split get_maintainer.pl output into To (maintainers, reviewers) and Cc
 * (lists and everyone else), dropping the role annotations.
 * @param {string} out
 */
function splitRecipients(out) {
	/** @type {string[]} */
	const to = [];
	/** @type {string[]} */
	const cc = [];
	for (const line of out.split('\n')) {
		const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(line.trim());
		const addr = (m ? m[1] : line).trim();
		if (!addr || !addr.includes('@'))
			continue;
		const role = m ? m[2] : '';
		(/\b(maintainer|reviewer):/.test(role) ? to : cc).push(addr);
	}
	return { to, cc };
}

module.exports = { Patches, splitRecipients, COVER_TEMPLATE };

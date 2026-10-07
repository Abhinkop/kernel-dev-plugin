// @ts-check
'use strict';

const vscode = require('vscode');
const { git } = require('./git');

/**
 * Read-only documents for git objects, opened as ordinary editor tabs so
 * they can be scrolled, searched and copied like any file:
 *
 *   kernel-git:/commit/<hash>/<title>.diff          whole commit
 *   kernel-git:/full/<hash>/<title>.diff?<file>     whole commit, opened from <file>
 *   kernel-git:/file/<hash>/<title>.diff?<file>     only <file>'s part of the commit
 *   kernel-git:/stat/<hash>/<title>.diff            message and file list only (huge commits)
 *   kernel-git:/blob/<rev>/<path>                   <path> as of <rev>
 *
 * The .diff suffix gives commits diff highlighting; blobs keep their own
 * file name, so they get the language of the file.
 */
const SCHEME = 'kernel-git';

/** @implements {vscode.TextDocumentContentProvider} */
class GitDocuments {
	/** @param {string} root */
	constructor(root) {
		this.root = root;
		providerRoot = root;
	}

	/**
	 * The file's names in a commit: limiting `git show` to the new name
	 * alone defeats rename detection and shows a rename as a new file, so
	 * include the old name when the commit renamed it.
	 * @param {string} rev @param {string} file
	 */
	async namesIn(rev, file) {
		const status = await git(this.root, ['show', '-M', '--format=', '--name-status', rev]);
		for (const line of status.split('\n')) {
			const [st, from, to] = line.split('\t');
			if (st && st.startsWith('R') && to === file)
				return [from, to];
		}
		return [file];
	}

	/** @param {vscode.Uri} uri */
	async provideTextDocumentContent(uri) {
		const [, kind, rev, ...rest] = uri.path.split('/');
		const file = decodeURIComponent(uri.query);
		try {
			if (kind === 'blob')
				return await git(this.root, ['show', `${rev}:${rest.join('/')}`]);
			if (kind === 'stat')
				return await git(this.root, ['show', '--format=fuller', '--stat=200', '--no-color', rev]);
			const args = ['show', '--format=fuller', '--stat', '--patch', '-M', '--no-color', rev];
			if (kind === 'file' && file)
				args.push('--', ...await this.namesIn(rev, file));
			return await git(this.root, args);
		} catch (e) {
			// A blob that does not exist at that revision (added or deleted
			// there) reads as empty, which is what a diff against it needs.
			return kind === 'blob' ? '' : `Could not read ${rev}:\n${/** @type {Error} */ (e).message}\n`;
		}
	}
}

/**
 * @param {string} hash
 * @param {string} subject
 * @param {'commit'|'full'|'file'|'stat'} kind
 * @param {string} [file]
 */
function commitUri(hash, subject, kind, file) {
	const title = `${hash.slice(0, 12)} ${subject}`.replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
	return vscode.Uri.from({ scheme: SCHEME, path: `/${kind}/${hash}/${title}.diff`, query: file ? encodeURIComponent(file) : '' });
}

/** @param {string} rev @param {string} file repository-relative */
function blobUri(rev, file) {
	return vscode.Uri.from({ scheme: SCHEME, path: `/blob/${rev}/${file}` });
}

// Changed lines above which a whole commit is not opened.
const HUGE = 200000;

/** Lines added plus removed by a commit. @param {string} root @param {string} hash */
async function changedLines(root, hash) {
	const out = await git(root, ['show', '--numstat', '--format=', hash]);
	let n = 0;
	for (const line of out.split('\n')) {
		const [a, d] = line.split('\t');
		n += (+a || 0) + (+d || 0);
	}
	return n;
}

/**
 * Open a commit in an editor tab.
 * @param {string} root
 * @param {string} rev
 * @param {{ file?: string, onlyFile?: boolean }} [opts]
 */
async function openCommit(root, rev, opts = {}) {
	const [hash, subject] = (await git(root, ['log', '-1', '--format=%H%x00%s', rev])).trim().split('\0');
	/** @type {'commit'|'full'|'file'|'stat'} */
	let kind = opts.file ? (opts.onlyFile ? 'file' : 'full') : 'commit';
	// VS Code will not open a document over 50MB, which some commits are
	// as a whole (the 2.6.12 import that much old code blames to): show
	// only the file's part of those, or just the message and file list.
	if (kind !== 'file') {
		const lines = await changedLines(root, hash);
		if (lines > HUGE) {
			kind = opts.file ? 'file' : 'stat';
			vscode.window.showInformationMessage(`Kernel: ${hash.slice(0, 12)} changes ${lines.toLocaleString()} lines; showing ${opts.file ? `only ${opts.file}` : 'its message and file list'}.`);
		}
	}
	const doc = await vscode.workspace.openTextDocument(commitUri(hash, subject, kind, opts.file));
	await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Switch an open commit tab between the whole commit and the file's part.
 * @param {vscode.Uri | undefined} uri
 * @param {boolean} onlyFile
 */
async function toggleCommitView(uri, onlyFile) {
	if (!uri || uri.scheme !== SCHEME)
		return;
	const [, , hash, ...rest] = uri.path.split('/');
	let kind = onlyFile ? 'file' : 'full';
	if (!onlyFile && await changedLines(root(uri), hash) > HUGE) {
		kind = 'stat';
		vscode.window.showInformationMessage(`Kernel: ${hash.slice(0, 12)} is too large to show whole; showing its message and file list.`);
	}
	const target = uri.with({ path: `/${kind}/${hash}/${rest.join('/')}` });
	// Replace the tab rather than piling up a second one.
	if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString())
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	const doc = await vscode.workspace.openTextDocument(target);
	await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * The kernel tree a kernel-git document belongs to (the provider's root).
 * @param {vscode.Uri} _uri
 */
function root(_uri) {
	return providerRoot;
}
/** @type {string} */
let providerRoot = '';

/**
 * Commit hash from a kernel-git commit URI.
 * @param {vscode.Uri} uri
 */
function hashOf(uri) {
	return uri.scheme === SCHEME ? uri.path.split('/')[2] : undefined;
}

module.exports = { SCHEME, GitDocuments, commitUri, blobUri, openCommit, toggleCommitView, hashOf };

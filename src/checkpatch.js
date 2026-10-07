// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const { git, lineInWorkingTree } = require('./git');

/**
 * One checkpatch finding.
 * @typedef {Object} Finding
 * @property {'ERROR'|'WARNING'|'CHECK'} level
 * @property {string} type       checkpatch type, e.g. SPACING (--show-types)
 * @property {string} message
 * @property {string} [file]     repository-relative; absent for commit-message findings
 * @property {number} [line]     1-based, in the checked version of the file
 */

/**
 * @typedef {Object} Report
 * @property {Finding[]} findings
 * @property {number} errors
 * @property {number} warnings
 * @property {number} checks
 * @property {string} output     checkpatch's raw output
 */

// Types about the commit message or its tags rather than the code. With
// --showfile checkpatch still attaches some of them to a file and line
// (the last hunk), which would put them on the wrong source line.
const COMMIT_TYPES = new Set([
	'MISSING_SIGN_OFF', 'BAD_SIGN_OFF', 'NO_AUTHOR_SIGN_OFF', 'FROM_SIGN_OFF_MISMATCH', 'COMMIT_MESSAGE',
	'COMMIT_LOG_LONG_LINE', 'COMMIT_LOG_VERSIONING', 'COMMIT_LOG_WRONG_LINK', 'COMMIT_COMMENT_SYMBOL',
	'GERRIT_CHANGE_ID', 'BAD_FIXES_TAG', 'UNKNOWN_COMMIT_ID', 'GIT_COMMIT_ID', 'EMAIL_SUBJECT',
	'BAD_REPORTED_BY_LINK', 'BAD_STABLE_ADDRESS_STYLE', 'DIFF_IN_COMMIT_MSG', 'MISSING_FIXES_TAG',
	'BAD_COMMIT_SEPARATOR', 'COMMIT_LOG_USE_LINK', 'FILE_PATH_CHANGES',
]);

/**
 * @param {string} out checkpatch --terse --showfile --show-types output
 * @returns {Report}
 */
function parse(out) {
	/** @type {Finding[]} */
	const findings = [];
	for (const line of out.split('\n')) {
		const m = /^(.*?):(\d+): (ERROR|WARNING|CHECK):([A-Z0-9_]+): (.*)$/.exec(line);
		if (!m)
			continue;
		const [, file, lineNo, level, type, message] = m;
		const commitLevel = !file || file === '-' || COMMIT_TYPES.has(type);
		findings.push({
			level: /** @type {Finding['level']} */ (level), type, message,
			...(commitLevel ? {} : { file, line: +lineNo }),
		});
	}
	const count = (/** @type {string} */ l) => findings.filter(f => f.level === l).length;
	return { findings, errors: count('ERROR'), warnings: count('WARNING'), checks: count('CHECK'), output: out };
}

/** checkpatch arguments from the settings. @param {string} root */
function options(root) {
	const cfg = vscode.workspace.getConfiguration('kernelDev', vscode.Uri.file(root));
	const args = ['--terse', '--showfile', '--show-types', '--color=never'];
	if (cfg.get('checkpatch.strict', false))
		args.push('--strict');
	const ignore = /** @type {string[]} */ (cfg.get('checkpatch.ignore', []));
	if (ignore.length)
		args.push(`--ignore=${ignore.join(',')}`);
	return args;
}

/**
 * Run scripts/checkpatch.pl. It exits non-zero when it finds problems,
 * which is not a failure here.
 * @param {string} root @param {string[]} args @param {string} [input]
 * @returns {Promise<string>}
 */
function run(root, args, input) {
	return new Promise((resolve, reject) => {
		const child = execFile('perl', [path.join(root, 'scripts', 'checkpatch.pl'), ...args], {
			cwd: root, maxBuffer: 64 << 20,
		}, (err, stdout, stderr) => {
			if (err && !stdout && stderr)
				reject(new Error(stderr.trim().split('\n').slice(0, 3).join('\n')));
			else
				resolve(stdout);
		});
		if (input !== undefined && child.stdin)
			child.stdin.end(input);
	});
}

/**
 * Check uncommitted changes (staged and unstaged, against HEAD).
 * @param {string} root
 * @returns {Promise<Report | undefined>} undefined when there are no changes
 */
async function checkWorkingChanges(root) {
	const diff = await git(root, ['diff', 'HEAD', '--no-color']);
	if (!diff.trim())
		return undefined;
	return parse(await run(root, [...options(root), '--no-signoff', '-'], diff));
}

/** @param {string} root @param {string} commit */
async function checkCommit(root, commit) {
	return parse(await run(root, [...options(root), '--git', commit]));
}

/**
 * Publishes findings to the Problems panel, keeping the working-changes
 * results and the series results apart so re-running one does not wipe
 * the other.
 */
class Problems {
	/** @param {string} root */
	constructor(root) {
		this.root = root;
		this.collection = vscode.languages.createDiagnosticCollection('checkpatch');
		/** @type {Map<string, { file: string, line: number, f: Finding, origin: string }[]>} origin -> placed findings */
		this.byOrigin = new Map();
	}

	/**
	 * @param {string} origin 'working' or a commit hash
	 * @param {Finding[]} findings
	 * @param {string} [rev] the findings' line numbers are in this revision; mapped to the working tree
	 */
	async set(origin, findings, rev) {
		const placed = [];
		for (const f of findings) {
			if (!f.file || !f.line)
				continue;
			const at = f.line;
			const line = rev ? await lineInWorkingTree(this.root, rev, f.file, at).catch(() => at) : at;
			placed.push({ file: f.file, line, f, origin });
		}
		this.byOrigin.set(origin, placed);
		this.publish();
	}

	/** @param {(origin: string) => boolean} keep */
	prune(keep) {
		for (const origin of [...this.byOrigin.keys()])
			if (!keep(origin))
				this.byOrigin.delete(origin);
		this.publish();
	}

	publish() {
		/** @type {Map<string, vscode.Diagnostic[]>} */
		const byFile = new Map();
		const seen = new Set();
		for (const placed of this.byOrigin.values()) {
			for (const p of placed) {
				// The same problem found in a commit and in the working tree
				// is shown once.
				const key = `${p.file}:${p.line}:${p.f.type}:${p.f.message}`;
				if (seen.has(key))
					continue;
				seen.add(key);
				const d = new vscode.Diagnostic(new vscode.Range(p.line - 1, 0, p.line - 1, 1000), p.f.message,
					p.f.level === 'ERROR' ? vscode.DiagnosticSeverity.Error
						: p.f.level === 'WARNING' ? vscode.DiagnosticSeverity.Warning
						: vscode.DiagnosticSeverity.Information);
				d.source = p.origin === 'working' ? 'checkpatch' : `checkpatch ${p.origin.slice(0, 12)}`;
				d.code = p.f.type;
				const list = byFile.get(p.file) || [];
				list.push(d);
				byFile.set(p.file, list);
			}
		}
		this.collection.clear();
		for (const [file, list] of byFile)
			this.collection.set(vscode.Uri.file(path.join(this.root, file)), list);
	}
}

module.exports = { parse, checkWorkingChanges, checkCommit, Problems, COMMIT_TYPES };

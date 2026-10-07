// @ts-check
'use strict';

const { execFile, spawn } = require('child_process');

/**
 * Run git in the kernel tree and resolve with stdout. Rejects with git's
 * stderr (first lines) on failure. `cancel` kills the process.
 *
 * @param {string} root
 * @param {string[]} args
 * @param {{ cancel?: { onCancellationRequested(f: () => void): any }, input?: string, env?: Record<string, string> }} [opts]
 * @returns {Promise<string>}
 */
function git(root, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile('git', args, {
			cwd: root,
			maxBuffer: 512 << 20,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
		}, (err, stdout, stderr) => {
			if (err)
				reject(new Error((stderr || err.message).trim().split('\n').slice(0, 4).join('\n')));
			else
				resolve(stdout);
		});
		if (opts.input !== undefined && child.stdin)
			child.stdin.end(opts.input);
		opts.cancel?.onCancellationRequested(() => child.kill());
	});
}

/**
 * Like git(), but resolves with { code, stdout, stderr } instead of
 * rejecting, for commands whose exit code carries meaning.
 * @param {string} root
 * @param {string[]} args
 * @param {{ input?: string, env?: Record<string, string> }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function gitStatus(root, args, opts = {}) {
	return new Promise(resolve => {
		const child = spawn('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) } });
		let stdout = '', stderr = '';
		child.stdout.on('data', d => { stdout += d; });
		child.stderr.on('data', d => { stderr += d; });
		child.on('error', e => resolve({ code: 127, stdout, stderr: String(e) }));
		child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
		if (opts.input !== undefined)
			child.stdin.end(opts.input);
		else
			child.stdin.end();
	});
}

/**
 * One commit as listed by log().
 * @typedef {Object} Commit
 * @property {string} hash
 * @property {string} short
 * @property {string} subject
 * @property {string} author
 * @property {string} email
 * @property {string} date      ISO 8601
 * @property {string} [path]    the file's path in this commit (history with --follow)
 */

const FIELDS = ['%H', '%h', '%s', '%an', '%ae', '%aI'];
const RS = '\x1e', FS = '\x1f';

/**
 * git log with a parseable format. Extra args go before `--`.
 * @param {string} root
 * @param {string[]} args
 * @param {{ paths?: string[], names?: boolean, cancel?: any }} [opts]
 *   names: also return each commit's file name (--name-only), for --follow
 * @returns {Promise<Commit[]>}
 */
async function log(root, args, opts = {}) {
	const out = await git(root, [
		'log', `--format=${RS}${FIELDS.join(FS)}`, ...(opts.names ? ['--name-only'] : []), ...args,
		...(opts.paths ? ['--', ...opts.paths] : []),
	], { cancel: opts.cancel });
	return out.split(RS).slice(1).map(chunk => {
		const [head, ...rest] = chunk.split('\n');
		const [hash, short, subject, author, email, date] = head.split(FS);
		const path = rest.map(l => l.trim()).filter(Boolean).pop();
		return { hash, short, subject, author, email, date, ...(path ? { path } : {}) };
	});
}

/**
 * The kernel's Fixes: tag for a commit: 12-character hash and subject.
 * @param {string} root @param {string} rev
 */
async function fixesLine(root, rev) {
	return (await git(root, ['log', '-1', '--abbrev=12', '--format=Fixes: %h ("%s")', rev])).trim();
}

/** @param {string} root @param {string} rev */
async function exists(root, rev) {
	return (await gitStatus(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).code === 0;
}

/**
 * Path of a file relative to the repository top, or undefined when it is
 * outside the tree.
 * @param {string} root @param {string} file
 */
function relative(root, file) {
	const rel = require('path').relative(root, file);
	return rel && !rel.startsWith('..') && !require('path').isAbsolute(rel) ? rel.split(require('path').sep).join('/') : undefined;
}

/**
 * Map a line number across a diff (`git diff -U0` output between an old
 * and a new version of a file). Lines outside hunks shift by what the
 * hunks before them added or removed; a line inside a hunk maps to the
 * same position in the hunk's other side.
 * @param {string} diff
 * @param {number} line 1-based
 * @param {'toOld'|'toNew'} direction
 */
function mapLine(diff, line, direction) {
	let shift = 0;
	for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
		const old = { start: +m[1], count: m[2] === undefined ? 1 : +m[2] };
		const neu = { start: +m[3], count: m[4] === undefined ? 1 : +m[4] };
		const [from, to] = direction === 'toOld' ? [neu, old] : [old, neu];
		// First line after the hunk on each side; a count of 0 means the
		// hunk sits after line <start> (pure insertion or deletion).
		const fromNext = from.count ? from.start + from.count : from.start + 1;
		const toNext = to.count ? to.start + to.count : to.start + 1;
		if (line < (from.count ? from.start : fromNext))
			break;
		if (line < fromNext)
			return Math.max(1, to.start + Math.min(line - from.start, Math.max(to.count - 1, 0)));
		shift = toNext - fromNext;
	}
	return Math.max(1, line + shift);
}

/**
 * Where a line of `file` as of `rev` is in the working tree now.
 * @param {string} root @param {string} rev @param {string} file @param {number} line
 */
async function lineInWorkingTree(root, rev, file, line) {
	return mapLine(await git(root, ['diff', '-U0', '--no-color', rev, '--', file]), line, 'toNew');
}

module.exports = { git, gitStatus, log, fixesLine, exists, relative, mapLine, lineInWorkingTree };

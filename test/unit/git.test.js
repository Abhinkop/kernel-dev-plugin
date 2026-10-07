'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mock = require('../helpers/vscode');
const { makeRepo, tempDir } = require('../helpers/repo');

const git = require('../../src/git');
const commits = require('../../src/commits');
const { FileHistory, registerHistory, openOnLore } = require('../../src/history');
const blame = require('../../src/blame');
const checkpatch = require('../../src/checkpatch');

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

/** A repository with a file edited over a few commits and then renamed. */
function historyRepo() {
	const r = makeRepo();
	const c1 = r.commit('drivers/foo: add foo.c', { 'drivers/foo/foo.c': lines(20) }, '2026-01-01T10:00:00Z');
	const c2 = r.commit('drivers/foo: rework line 5', { 'drivers/foo/foo.c': lines(20).replace('line 5\n', 'line five\n') }, '2026-01-02T10:00:00Z');
	const c3 = r.commit('drivers/foo: rename foo.c to bar.c', { 'drivers/foo/foo.c': null, 'drivers/foo/bar.c': lines(20).replace('line 5\n', 'line five\n') }, '2026-01-03T10:00:00Z');
	const c4 = r.commit('drivers/foo: append a line', { 'drivers/foo/bar.c': lines(20).replace('line 5\n', 'line five\n') + 'line 21\n' }, '2026-01-04T10:00:00Z');
	return { r, c1, c2, c3, c4 };
}

const wait = async (cond, ms = 5000) => {
	for (let t = 0; t < ms && !cond(); t += 20)
		await new Promise(res => setTimeout(res, 20));
};

describe('git helpers', () => {
	it('parses git log, with file names for --follow', async () => {
		const { r, c1, c4 } = historyRepo();
		const log = await git.log(r.dir, ['--follow'], { paths: ['drivers/foo/bar.c'], names: true });
		assert.deepStrictEqual(log.map(c => c.subject), ['drivers/foo: append a line', 'drivers/foo: rename foo.c to bar.c',
			'drivers/foo: rework line 5', 'drivers/foo: add foo.c']);
		assert.strictEqual(log[0].hash, c4);
		assert.strictEqual(log[3].hash, c1);
		assert.strictEqual(log[3].path, 'drivers/foo/foo.c', 'the name before the rename');
		assert.strictEqual(log[0].author, 'Test Author');
		assert.strictEqual(log[0].short.length >= 7, true);
		r.remove();
	});

	it('formats Fixes: lines and checks revisions', async () => {
		const { r, c2 } = historyRepo();
		assert.strictEqual(await git.fixesLine(r.dir, c2), `Fixes: ${c2.slice(0, 12)} ("drivers/foo: rework line 5")`);
		assert.strictEqual(await git.exists(r.dir, c2), true);
		assert.strictEqual(await git.exists(r.dir, 'nope'), false);
		await assert.rejects(git.git(r.dir, ['show', 'nope']), /nope/);
		const st = await git.gitStatus(r.dir, ['rev-parse', 'nope']);
		assert.notStrictEqual(st.code, 0);
		r.remove();
	});

	it('makes paths relative to the tree', () => {
		assert.strictEqual(git.relative('/k', '/k/a/b.c'), 'a/b.c');
		assert.strictEqual(git.relative('/k', '/other/b.c'), undefined);
		assert.strictEqual(git.relative('/k', '/k'), undefined);
	});

	it('maps line numbers across diffs', () => {
		// line 3 changed, 2 lines inserted after old line 6, old line 10 deleted
		const diff = '@@ -3 +3 @@\n@@ -6,0 +7,2 @@\n@@ -10 +11,0 @@\n';
		const toNew = (l) => git.mapLine(diff, l, 'toNew');
		const toOld = (l) => git.mapLine(diff, l, 'toOld');
		assert.deepStrictEqual([1, 2, 3, 4, 6, 7, 9, 11, 12].map(toNew), [1, 2, 3, 4, 6, 9, 11, 12, 13]);
		assert.deepStrictEqual([1, 6, 7, 8, 9, 11, 12].map(toOld), [1, 6, 6, 6, 7, 9, 11]);
		assert.strictEqual(git.mapLine('', 5, 'toNew'), 5);
	});

	it('maps a committed line to the working tree', async () => {
		const { r, c4 } = historyRepo();
		r.write('drivers/foo/bar.c', 'new top\nnew top 2\n' + r.read('drivers/foo/bar.c'));
		assert.strictEqual(await git.lineInWorkingTree(r.dir, c4, 'drivers/foo/bar.c', 10), 12);
		r.remove();
	});
});

describe('commit documents', () => {
	it('shows a whole commit, one file of it, its file list, and a file at a revision', async () => {
		const { r, c2, c3 } = historyRepo();
		const docs = new commits.GitDocuments(r.dir);
		const full = await docs.provideTextDocumentContent(commits.commitUri(c2, 'x', 'full', 'drivers/foo/foo.c'));
		assert.match(full, new RegExp(`^commit ${c2}`));
		assert.match(full, /^AuthorDate:/m);
		assert.match(full, /-line 5\n\+line five/);
		const renamed = await docs.provideTextDocumentContent(commits.commitUri(c3, 'x', 'file', 'drivers/foo/bar.c'));
		assert.match(renamed, /rename from drivers\/foo\/foo\.c/, 'the file view keeps the rename');
		const stat = await docs.provideTextDocumentContent(commits.commitUri(c3, 'x', 'stat'));
		assert.match(stat, /foo\.c => bar\.c/);
		assert.ok(!/^diff --git/m.test(stat));
		assert.strictEqual(await docs.provideTextDocumentContent(commits.blobUri(c2, 'drivers/foo/foo.c')), lines(20).replace('line 5\n', 'line five\n'));
		assert.strictEqual(await docs.provideTextDocumentContent(commits.blobUri(c2, 'no/such.c')), '', 'a missing blob is empty');
		assert.match(await docs.provideTextDocumentContent(commits.commitUri('0'.repeat(40), 'x', 'commit')), /^Could not read/);
		r.remove();
	});

	it('names tabs after the commit and opens them', async () => {
		const { r, c2 } = historyRepo();
		const uri = commits.commitUri(c2, 'drivers/foo: rework: line 5?', 'full', 'drivers/foo/foo.c');
		assert.strictEqual(uri.scheme, 'kernel-git');
		assert.strictEqual(uri.path, `/full/${c2}/${c2.slice(0, 12)} drivers foo rework line 5.diff`);
		assert.strictEqual(decodeURIComponent(uri.query), 'drivers/foo/foo.c');
		assert.strictEqual(commits.hashOf(uri), c2);
		new commits.GitDocuments(r.dir);
		await commits.openCommit(r.dir, c2, { file: 'drivers/foo/foo.c' });
		assert.match(mock.state.log.pop().uri, /^kernel-git:\/full\//);
		await commits.toggleCommitView(mock.vscode.window.activeTextEditor.document.uri, true);
		assert.match(mock.state.log.pop().uri, /^kernel-git:\/file\//);
		r.remove();
	});
});

describe('file history', () => {
	it('lists a file\'s commits following renames, filters, and line history', async () => {
		const { r, c2, c4 } = historyRepo();
		const h = new FileHistory(r.dir);
		h.view = { message: '', description: '' };
		h.show({ kind: 'file', file: 'drivers/foo/bar.c' });
		await wait(() => !h.loading);
		let items = h.getChildren();
		assert.deepStrictEqual(items.map(i => i.label).slice(0, 2), ['drivers/foo: append a line', 'drivers/foo: rename foo.c to bar.c']);
		assert.strictEqual(items.length, 4);
		assert.strictEqual(h.view.description, '4 commits');
		assert.deepStrictEqual(items[0].command.arguments, [c4, 'drivers/foo/bar.c']);
		assert.strictEqual(items[3].file, 'drivers/foo/foo.c');

		h.setFilter('rework');
		await wait(() => !h.loading);
		assert.deepStrictEqual(h.getChildren().map(i => i.label), ['drivers/foo: rework line 5']);
		h.setFilter('nothing matches this');
		await wait(() => !h.loading);
		assert.deepStrictEqual(h.getChildren().map(i => i.label), ['No matching commits.']);

		h.show({ kind: 'lines', file: 'drivers/foo/bar.c', start: 5, end: 5 });
		await wait(() => !h.loading);
		assert.ok(h.commits.some(c => c.hash === c2), 'the commit that changed line 5');
		assert.strictEqual(h.view.message, 'Lines 5–5 of drivers/foo/bar.c');
		r.remove();
	});

	it('pages long histories 200 at a time', async () => {
		const r = makeRepo();
		for (let i = 1; i <= 205; i++)
			r.write('f.c', `${i}\n`), r.git('add', '.'), r.git('commit', '-q', '-m', `change ${i}`);
		const h = new FileHistory(r.dir);
		h.show({ kind: 'file', file: 'f.c' });
		await wait(() => !h.loading);
		assert.strictEqual(h.commits.length, 200);
		assert.strictEqual(h.getChildren().pop().label, 'Load 200 more…');
		await h.load();
		assert.strictEqual(h.commits.length, 205);
		r.remove();
	}).timeout(120000);

	it('follows the editor and runs its commands', async () => {
		const { r, c2, c3 } = historyRepo();
		const ctx = { subscriptions: [] };
		new commits.GitDocuments(r.dir);
		const h = registerHistory(ctx, r.dir);
		await mock.vscode.window.showTextDocument(mock.vscode.Uri.file(path.join(r.dir, 'drivers/foo/bar.c')));
		h.followEditor(mock.vscode.window.activeTextEditor);
		await wait(() => !h.loading && h.commits.length > 0);
		const item = h.getChildren().find(i => i.commit.hash === c3);
		await mock.vscode.commands.executeCommand('kernelDev.git.copyFixes', item);
		assert.match(mock.state.clipboard, /^Fixes: [0-9a-f]{12} \("drivers\/foo: rename foo\.c to bar\.c"\)$/);
		await mock.vscode.commands.executeCommand('kernelDev.git.copyHash', item);
		assert.strictEqual(mock.state.clipboard, c3);
		await mock.vscode.commands.executeCommand('kernelDev.git.compareWithPrevious', item);
		const diff = mock.state.executed.find(e => e.id === 'vscode.diff');
		assert.match(String(diff.args[0]), new RegExp(`/blob/${c3}\\^/drivers/foo/foo\\.c$`), 'the old name on the left');
		await mock.vscode.commands.executeCommand('kernelDev.git.openAtCommit', item);
		assert.match(mock.state.log.filter(l => l.kind === 'show').pop().uri, /\/blob\//);
		mock.answer('Search lore');
		await openOnLore(r.dir, c2);
		assert.match(mock.state.log.pop().uri, /^https:\/\/lore\.kernel\.org\/all\/\?q=s%3A%22drivers%2Ffoo%3A%20rework%20line%205%22$/);
		r.remove();
	});
});

describe('blame', () => {
	const porcelain = [
		'aaaa000000000000000000000000000000000001 3 1 2',
		'author Alice', 'author-mail <alice@example.com>', 'author-time 1700000000', 'summary first change',
		'previous bbbb000000000000000000000000000000000002 old/name.c', 'filename new/name.c',
		'\tint a;',
		'aaaa000000000000000000000000000000000001 4 2',
		'\tint b;',
		'0000000000000000000000000000000000000000 3 3 1',
		'author Not Committed Yet', 'summary Version of new/name.c from new/name.c', 'filename new/name.c',
		'\tint c;',
	].join('\n');

	it('parses porcelain output', () => {
		const l = blame.parsePorcelain(porcelain);
		assert.strictEqual(l.length, 3);
		assert.deepStrictEqual([l[0].origLine, l[0].finalLine, l[0].author, l[0].email, l[0].summary, l[0].text],
			[3, 1, 'Alice', 'alice@example.com', 'first change', 'int a;']);
		assert.deepStrictEqual(l[0].previous, { hash: 'bbbb000000000000000000000000000000000002', file: 'old/name.c' });
		assert.strictEqual(l[1].summary, 'first change', 'repeated commits reuse the header');
		assert.strictEqual(l[1].origLine, 4);
	});

	it('blames files, unsaved text and revisions', async () => {
		const { r, c2, c4 } = historyRepo();
		let l = await blame.blame(r.dir, { file: 'drivers/foo/bar.c' });
		assert.strictEqual(l.length, 21);
		assert.strictEqual(l[4].hash, c2, 'line 5 last changed by the rework');
		assert.strictEqual(l[20].hash, c4);
		const unsaved = 'inserted\n' + r.read('drivers/foo/bar.c');
		l = await blame.blame(r.dir, { file: 'drivers/foo/bar.c', contents: unsaved });
		assert.match(l[0].hash, /^0{40}$/);
		assert.strictEqual(l[5].hash, c2);
		l = await blame.blame(r.dir, { file: 'drivers/foo/foo.c', rev: c2 }, { line: 5 });
		assert.strictEqual(l.filter(Boolean)[0].hash, c2);
		r.remove();
	});

	it('maps a line of a commit to its parent', async () => {
		const { r, c2, c1 } = historyRepo();
		const f = 'drivers/foo/foo.c';
		assert.strictEqual(await blame.mapToParent(r.dir, c1, f, c2, f, 10), 10);
		assert.strictEqual(await blame.mapToParent(r.dir, c1, f, c2, f, 5), 5);
		r.remove();
	});

	it('annotates with clickable hashes, grouped by commit', async () => {
		const { r, c2 } = historyRepo();
		const a = new blame.BlameAnnotations(r.dir);
		const ed = await mock.vscode.window.showTextDocument(mock.vscode.Uri.file(path.join(r.dir, 'drivers/foo/bar.c')));
		let changed = 0;
		a.onDidChangeInlayHints(() => changed++);
		await a.toggle(ed);
		assert.ok(a.isOn(ed) && changed === 1);
		const hints = a.provideInlayHints(ed.document, new mock.vscode.Range(0, 0, 25, 0));
		assert.strictEqual(hints.length, 21);
		const firstOf = hints.filter(h => h.label.length === 2);
		assert.ok(firstOf.length >= 3, 'one labelled hint per run of lines');
		const rework = hints[4];
		assert.strictEqual(rework.label[0].value, c2.slice(0, 8));
		assert.deepStrictEqual(rework.label[0].command.arguments, [c2, 'drivers/foo/foo.c']);
		assert.match(rework.label[0].tooltip.value, /\[Open commit\]\(command:kernelDev\.git\.openCommit/);
		assert.strictEqual(hints[1].label[0].value.trim(), '', 'continuation lines are padding');
		await a.toggle(ed);
		assert.deepStrictEqual(a.provideInlayHints(ed.document, new mock.vscode.Range(0, 0, 25, 0)), []);
		r.remove();
	});

	it('finds the commit that introduced a line, and blames before a commit', async () => {
		const { r, c1, c2 } = historyRepo();
		const ctx = { subscriptions: [] };
		new commits.GitDocuments(r.dir);
		const { blameView } = blame.registerBlame(ctx, r.dir);
		blameView.view = { visible: true, message: '' };
		await blameView.update({ file: 'drivers/foo/bar.c' }, 5, 'line five');
		const items = blameView.getChildren();
		assert.strictEqual(items[1].commit.hash, c2);
		const earlier = items.find(i => i.children);
		assert.deepStrictEqual(earlier.children.map(i => i.commit.hash), [c1], 'c1 introduced the line');
		await mock.vscode.commands.executeCommand('kernelDev.blame.before', items[1]);
		assert.match(mock.state.log.filter(l => l.kind === 'show').pop().uri, new RegExp(`/blob/${c1}/drivers/foo/foo\\.c$`));
		await mock.vscode.commands.executeCommand('kernelDev.blame.copyFixes', items[1]);
		assert.match(mock.state.clipboard, /rework line 5/);
		r.remove();
	});
});

describe('checkpatch', () => {
	it('parses findings and keeps commit-message ones off source lines', () => {
		const r = checkpatch.parse([
			'drivers/x.c:57: WARNING:SPACING: space prohibited before semicolon',
			'drivers/x.c:65: ERROR:MISSING_SIGN_OFF: Missing Signed-off-by: line(s)',
			':12: WARNING:COMMIT_LOG_LONG_LINE: Prefer a maximum 75 chars per line',
			'drivers/x.c:3: CHECK:PARENTHESIS_ALIGNMENT: Alignment should match open parenthesis',
			'total: 1 errors, 2 warnings, 1 checks, 7 lines checked',
		].join('\n'));
		assert.deepStrictEqual([r.errors, r.warnings, r.checks], [1, 2, 1]);
		assert.deepStrictEqual(r.findings.map(f => [f.type, f.file, f.line]), [
			['SPACING', 'drivers/x.c', 57], ['MISSING_SIGN_OFF', undefined, undefined],
			['COMMIT_LOG_LONG_LINE', undefined, undefined], ['PARENTHESIS_ALIGNMENT', 'drivers/x.c', 3],
		]);
	});

	it('runs the tree\'s checkpatch with the configured options and places findings', async () => {
		const r = makeRepo();
		const c = r.commit('x: add', { 'x.c': lines(10) });
		r.write('scripts/checkpatch.pl', '#!/usr/bin/perl\nprint "ARGS @ARGV\\n"; print "x.c:3: ERROR:TRAILING_WHITESPACE: trailing whitespace\\n";\n');
		mock.state.config['kernelDev.checkpatch.strict'] = true;
		mock.state.config['kernelDev.checkpatch.ignore'] = ['FILE_PATH_CHANGES', 'SPDX'];
		const rep = await checkpatch.checkCommit(r.dir, c);
		assert.match(rep.output, /ARGS --terse --showfile --show-types --color=never --strict --ignore=FILE_PATH_CHANGES,SPDX --git [0-9a-f]+/);
		assert.strictEqual(await checkpatch.checkWorkingChanges(r.dir), undefined, 'no changes');
		r.write('x.c', 'two\nnew\nlines\n' + lines(10));
		const w = await checkpatch.checkWorkingChanges(r.dir);
		assert.match(w.output, /--no-signoff -/);
		const p = new checkpatch.Problems(r.dir);
		await p.set(c, rep.findings, c);
		await p.set('working', w.findings);
		const d = mock.state.diagnostics.get(`checkpatch|${path.join(r.dir, 'x.c')}`);
		assert.deepStrictEqual(d.map(x => [x.range.start.line + 1, x.source]).sort(), [[3, 'checkpatch'], [6, `checkpatch ${c.slice(0, 12)}`]],
			'line 3 of the commit is line 6 now');
		p.prune(o => o === 'working');
		assert.strictEqual(mock.state.diagnostics.get(`checkpatch|${path.join(r.dir, 'x.c')}`).length, 1);
		r.remove();
	});
});

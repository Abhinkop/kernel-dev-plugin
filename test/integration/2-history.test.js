'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { api, labels, file, git, sleep } = require('./helpers');
const { time, until } = require('./perf');

describe('History tab', function () {
	let x;
	before(async () => { x = await api(); });

	it('lists the open file\'s history and opens commits in tabs', async () => {
		await vscode.window.showTextDocument(file('kernel/sched/core.c'));
		const h = x.history;
		await time('History tab', 'File History: first 200 commits of core.c', async () => {
			await vscode.commands.executeCommand('kernelDev.history.showFile', file('kernel/sched/core.c'));
			await until(() => !h.loading && h.commits.length > 0);
		}, () => `${h.commits.length} commits`);
		assert.strictEqual(h.commits.length, 200);
		const rows = await labels(h);
		assert.strictEqual(rows[rows.length - 1], 'Load 200 more…');

		await time('History tab', 'Load 200 more', async () => {
			await vscode.commands.executeCommand('kernelDev.history.loadMore');
			await until(() => !h.loading);
		});
		assert.strictEqual(h.commits.length, 400);

		const c = h.commits[0];
		const ed = await time('History tab', 'open a commit in a tab', async () => {
			await vscode.commands.executeCommand('kernelDev.git.openCommit', c.hash, c.path);
			await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'kernel-git');
			return vscode.window.activeTextEditor;
		}, e => `${e.document.lineCount} lines`);
		assert.strictEqual(ed.document.languageId, 'diff');
		assert.match(ed.document.getText(), new RegExp(`^commit ${c.hash}`));
		const tabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).length;
		const before = tabs();
		await vscode.commands.executeCommand('kernelDev.git.commitFileOnly');
		await until(() => vscode.window.activeTextEditor?.document.uri.path.startsWith('/file/'));
		assert.strictEqual(tabs(), before, 'the toggle replaces the tab');
		// Typing, as a user would: a commit tab is read-only.
		const now = vscode.window.activeTextEditor;
		const text = now.document.getText();
		await vscode.commands.executeCommand('type', { text: 'typed into a commit tab' });
		assert.strictEqual(now.document.getText(), text, 'commit tabs are read-only');
		assert.strictEqual(now.document.isDirty, false);
	});

	it('filters by message or author, and shows line history', async () => {
		const h = x.history;
		h.show({ kind: 'file', file: 'kernel/sched/core.c' });
		await until(() => !h.loading);
		await time('History tab', 'filter history (message or author)', async () => {
			h.setFilter('Zijlstra');
			await until(() => !h.loading);
		}, () => `${h.commits.length} matches`);
		assert.ok(h.commits.length > 0);
		assert.ok(h.commits.some(c => /zijlstra/i.test(c.author)), 'matches by author');
		await time('History tab', 'history of 10 selected lines (git log -L)', async () => {
			h.show({ kind: 'lines', file: 'kernel/sched/core.c', start: 4500, end: 4510 });
			await until(() => !h.loading);
		}, () => `${h.commits.length} commits`);
		assert.ok(h.commits.length > 0);
	});

	it('annotates blame with clickable hashes and opens the commit', async () => {
		const ed = await vscode.window.showTextDocument(file('kernel/sched/core.c'));
		const range = new vscode.Range(0, 0, 200, 0);
		const hints = await time('History tab', 'blame annotations for core.c', async () => {
			await vscode.commands.executeCommand('kernelDev.blame.toggle');
			let h = [];
			await until(async () => (h = (await vscode.commands.executeCommand('vscode.executeInlayHintProvider', ed.document.uri, range))
				.filter(x => Array.isArray(x.label))).length > 0);
			return h;
		}, h => `${h.length} hints for 200 lines`);
		const link = hints.find(h => h.label[0].command && !h.label[0].value.startsWith('1da177e4'));
		assert.strictEqual(link.label[0].command.command, 'kernelDev.git.openCommit');
		await vscode.commands.executeCommand(link.label[0].command.command, ...link.label[0].command.arguments);
		await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'kernel-git');
		assert.match(vscode.window.activeTextEditor.document.getText(), new RegExp(`^commit ${link.label[0].command.arguments[0]}`));
		await vscode.window.showTextDocument(ed.document);
		await vscode.commands.executeCommand('kernelDev.blame.toggle');
		const after = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', ed.document.uri, range);
		assert.strictEqual(after.filter(x => Array.isArray(x.label)).length, 0);
	});

	it('opens a commit too large for an editor as one file of it', async () => {
		const huge = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n').pop();
		const lines = git('show', '--numstat', '--format=', huge).split('\n').length;
		if (lines < 1000)
			return; // a tree without the 2.6.12 import
		await time('History tab', 'open the huge 2.6.12 import commit (one file)', async () => {
			await vscode.commands.executeCommand('kernelDev.git.openCommit', huge, 'kernel/sched.c');
			await until(() => vscode.window.activeTextEditor?.document.uri.path.includes(huge));
		});
		assert.ok(vscode.window.activeTextEditor.document.uri.path.startsWith('/file/'));
	});

	it('follows the cursor in the Blame view back to the introducing commit', async () => {
		const ed = await vscode.window.showTextDocument(file('kernel/sched/core.c'));
		await vscode.commands.executeCommand('kernelDev.blame.focus');
		const v = x.blame.blameView;
		await time('History tab', 'Blame view: line chain (blame + git log -L)', async () => {
			ed.selection = new vscode.Selection(4504, 0, 4504, 0);
			await until(() => v.state === 'done' || v.state === 'error', 60000);
		});
		assert.strictEqual(v.state, 'done');
		const rows = await labels(v);
		assert.ok(rows.length >= 2, rows.join('\n'));
		await sleep(10);
	});
});

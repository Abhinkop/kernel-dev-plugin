'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { api, labels, child, git, answer, tree, file } = require('./helpers');
const { time, until } = require('./perf');

describe('Kernel Git tab', function () {
	let x;
	const cfg = () => vscode.workspace.getConfiguration('kernelDev', vscode.workspace.workspaceFolders[0].uri);

	before(async () => {
		x = await api();
		// A two-patch series on top of kwb-test-base: the first with style
		// errors, the second clean.
		git('checkout', '-q', '-B', 'kwb-series', 'kwb-test-base');
		const f = path.join(tree(), 'drivers/gpu/drm/virtio/virtgpu_drv.c');
		fs.appendFileSync(f, '\nint kwb_test_var=0;   \n');
		git('commit', '-q', '-a', '-m', 'drm/virtio: add a test variable');
		fs.appendFileSync(f, '\nstatic int kwb_test_fn(void)\n{\n\treturn 0;\n}\n');
		git('commit', '-q', '-a', '-s', '-m', 'drm/virtio: add a test function', '-m', 'A short description of the change.');
		await cfg().update('patches.base', 'kwb-test-base', vscode.ConfigurationTarget.Workspace);
		await cfg().update('patches.outputDirectory', path.join(os.tmpdir(), 'kwb-it-patches', '${branch}', 'v${version}'), vscode.ConfigurationTarget.Workspace);
	});

	it('shows the series', async () => {
		await vscode.commands.executeCommand('kernelDev.series.focus');
		await time('Kernel Git tab', 'Series view: refresh (merge-base, log)', () => x.series.series.refresh());
		const rows = await labels(x.series.view, undefined, 2);
		assert.ok(rows.includes('Base — kwb-test-base (' + git('rev-parse', 'kwb-test-base').trim().slice(0, 12) + ')'), rows.join('\n'));
		assert.ok(rows.some(r => /^ {2}drm\/virtio: add a test variable — 1\/2$/.test(r)), rows.join('\n'));
	});

	it('runs checkpatch on every commit and puts findings in Problems', async () => {
		await time('Kernel Git tab', 'Check series: checkpatch on 2 commits (+ W=1 skipped, no build)', () =>
			vscode.commands.executeCommand('kernelDev.series.check'));
		const commits = await child(x.series.view, 'Commits');
		const rows = await labels(x.series.view, commits);
		assert.match(rows[0], /^drm\/virtio: add a test variable — 1\/2 · \d+ errors?/);
		const diags = vscode.languages.getDiagnostics(file('drivers/gpu/drm/virtio/virtgpu_drv.c'))
			.filter(d => String(d.source).startsWith('checkpatch'));
		assert.ok(diags.some(d => d.code === 'GLOBAL_INITIALISERS'), diags.map(d => d.code).join(','));
		const line = fs.readFileSync(path.join(tree(), 'drivers/gpu/drm/virtio/virtgpu_drv.c'), 'utf8').split('\n')[diags[0].range.start.line];
		assert.match(line, /kwb_test_var/, 'on the right line');
	});

	it('checks working changes', async () => {
		const f = path.join(tree(), 'kernel/sched/topology.c');
		fs.appendFileSync(f, '\nstatic int  kwb( void ) { return 0 ; }\n');
		await time('Kernel Git tab', 'Check working changes (checkpatch on git diff)', () =>
			vscode.commands.executeCommand('kernelDev.series.checkWorking'));
		assert.ok(x.series.series.working.errors > 0);
		git('checkout', '--', 'kernel/sched/topology.c');
	});

	it('fills recipients from get_maintainer.pl', async () => {
		await time('Kernel Git tab', 'Fill recipients (get_maintainer.pl)', () =>
			vscode.commands.executeCommand('kernelDev.series.fillRecipients'));
		assert.ok(x.series.patches.to.some(a => /airlied@redhat\.com/.test(a)), x.series.patches.to.join(', '));
		assert.ok(x.series.patches.cc.some(a => /dri-devel/.test(a)));
	});

	it('generates the series only after the checkpatch errors are acknowledged', async () => {
		git('config', 'branch.kwb-series.description', 'drm/virtio: test series\n\nTwo patches made by the integration tests.');
		const w = answer('showWarningMessage', [undefined]);
		await vscode.commands.executeCommand('kernelDev.series.generate');
		assert.match(w.asked[0][0], /checkpatch reports \d+ errors? in 1 of 2 commits/);
		assert.strictEqual(x.series.patches.output, undefined, 'nothing written');
		w.restore();
		const go = answer('showWarningMessage', ['Generate Anyway', 'Replace Them']);
		await time('Kernel Git tab', 'Generate patches (git format-patch, 2 + cover)', () =>
			vscode.commands.executeCommand('kernelDev.series.generate'));
		go.restore();
		const out = x.series.patches.output;
		assert.deepStrictEqual(out.files, ['0000-cover-letter.patch', '0001-drm-virtio-add-a-test-variable.patch', '0002-drm-virtio-add-a-test-function.patch']);
		assert.match(fs.readFileSync(path.join(out.dir, out.files[0]), 'utf8'), /^Subject: \[PATCH 0\/2\] drm\/virtio: test series$/m);
	});

	it('dry-runs git send-email and only then enables Send', async function () {
		const sender = x.series.sender;
		await time('Kernel Git tab', 'Send: git send-email --dry-run (3 mails)', () => vscode.commands.executeCommand('kernelDev.series.dryRun'));
		if (!sender.dry)
			return this.skip(); // git send-email not installed here
		assert.ok(sender.dry.ok, 'dry run OK');
		assert.strictEqual(sender.dry.mails.length, 3);
		assert.ok(sender.dryRunCurrent());
		const no = answer('showWarningMessage', [undefined]);
		const terminals = vscode.window.terminals.length;
		await vscode.commands.executeCommand('kernelDev.series.send');
		no.restore();
		assert.match(no.asked[0][0], /^Send 3 mails to \d+ addresses\?$/);
		assert.strictEqual(vscode.window.terminals.length, terminals, 'declined: nothing sent');
	});

	it('applies the generated patches with git am through the Apply view', async () => {
		const out = x.series.patches.output;
		git('checkout', '-q', '-B', 'kwb-apply', 'kwb-test-base');
		const open = answer('showOpenDialog', [out.files.slice(1).map(f => vscode.Uri.file(path.join(out.dir, f)))]);
		await vscode.commands.executeCommand('kernelDev.apply.openFiles');
		open.restore();
		const a = x.apply.apply;
		assert.deepStrictEqual(a.fetched.patches.length, 2);
		await time('Kernel Git tab', 'Apply 2 patches (git am -3)', () => vscode.commands.executeCommand('kernelDev.apply.applyCurrent'));
		assert.strictEqual(a.message, 'Applied 2 patches.');
		assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'drm/virtio: add a test function');
		const rows = await labels(x.apply.view);
		assert.ok(rows.some(r => /^Applied 2 patches\.$/.test(r)));
	});

	it('bisects over real commits', async () => {
		const range = git('rev-list', '--first-parent', '--max-count=9', 'kwb-test-base').trim().split('\n');
		const good = range[range.length - 1], bad = range[0];
		const target = range[4];
		const b = x.bisect.bisect;
		await time('Kernel Git tab', 'Bisect: start', () => b.start(bad, good));
		let steps = 0;
		await time('Kernel Git tab', 'Bisect: mark steps until found', async () => {
			while (b.active && !b.result && steps++ < 10) {
				let isBad = true;
				try { git('merge-base', '--is-ancestor', target, 'HEAD'); } catch { isBad = false; }
				await vscode.commands.executeCommand(isBad ? 'kernelDev.bisect.bad' : 'kernelDev.bisect.good');
			}
		}, () => `${steps} steps`);
		assert.ok(b.result, 'found');
		await vscode.commands.executeCommand('kernelDev.bisect.reset');
		assert.ok(!b.active);
	});

	after(async () => {
		await cfg().update('patches.base', undefined, vscode.ConfigurationTarget.Workspace);
		await cfg().update('patches.outputDirectory', undefined, vscode.ConfigurationTarget.Workspace);
	});
});

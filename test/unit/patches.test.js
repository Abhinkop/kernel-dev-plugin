'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mock = require('../helpers/vscode');
const { makeRepo, tempDir } = require('../helpers/repo');

const { Settings } = require('../../src/settings');
const { registerSeries, summary, statusIcon } = require('../../src/series');
const { splitRecipients, COVER_TEMPLATE } = require('../../src/patches');
const { parseDryRun } = require('../../src/send');
const { registerApply, messageId, mboxSubjects, parseB4 } = require('../../src/apply');
const { registerBisect } = require('../../src/bisect');

/** A tree with a branch of two commits over master, and stand-in kernel scripts. */
function seriesTree({ checkpatchErrors = 0 } = {}) {
	const r = makeRepo();
	r.write('scripts/checkpatch.pl', `#!/usr/bin/perl
my $git = grep { $_ eq '--git' } @ARGV;
${checkpatchErrors ? 'print "a.c:1: ERROR:SPACING: bad spacing\\n";' : ''}
print ":3: WARNING:COMMIT_LOG_LONG_LINE: long line\\n" if $git;
`);
	r.write('scripts/get_maintainer.pl', `#!/usr/bin/perl
print "Maint One <one\\@example.com> (maintainer:FOO DRIVER)\\n";
print "Rev Two <two\\@example.com> (reviewer:FOO DRIVER)\\n";
print "foo-list\\@vger.kernel.org (open list:FOO DRIVER)\\n";
print "Someone <s\\@example.com> (commit_signer:3/4=75%)\\n";
`);
	r.commit('scripts: add stand-ins');
	r.git('branch', 'base');
	r.git('checkout', '-q', '-b', 'topic');
	const c1 = r.commit('foo: add a.c', { 'a.c': 'int a;\n' });
	const c2 = r.commit('foo: add b.c', { 'b.c': 'int b;\n' });
	const ws = new Map();
	const storage = tempDir();
	const ctx = { subscriptions: [], storageUri: mock.vscode.Uri.file(storage), globalStorageUri: mock.vscode.Uri.file(storage),
		workspaceState: { get: (k, d) => (ws.has(k) ? ws.get(k) : d), update: async (k, v) => ws.set(k, v) } };
	const s = new Settings(ctx, { uri: mock.vscode.Uri.file(r.dir), name: 'linux', index: 0 });
	s.configured = () => undefined;
	mock.state.config['kernelDev.patches.base'] = 'base';
	mock.state.config['kernelDev.patches.outputDirectory'] = path.join(tempDir(), '${branch}/v${version}');
	return { r, c1, c2, s, ctx, ws };
}

const wait = async (cond, ms = 5000) => {
	for (let t = 0; t < ms && !cond(); t += 20)
		await new Promise(res => setTimeout(res, 20));
};

describe('series', () => {
	it('finds the commits over the base and asks for a base when there is none', async () => {
		const { r, c1, c2, ctx, s } = seriesTree();
		const { series, view } = registerSeries(ctx, s);
		await series.refresh();
		assert.strictEqual(series.info.branch, 'topic');
		assert.strictEqual(series.info.base, 'base');
		assert.deepStrictEqual(series.info.commits.map(c => c.hash), [c1, c2]);
		const labels = (await view.getChildren()).map(i => i.label);
		assert.deepStrictEqual(labels, ['Actions', 'Base', 'Version', 'Commits', 'Working changes', 'Check options', 'Patches']);
		const [actions, base] = await view.getChildren();
		assert.deepStrictEqual((await view.getChildren(actions)).map(i => [i.label, i.command.command]), [
			['Check series', 'kernelDev.series.check'], ['Check working changes', 'kernelDev.series.checkWorking'],
			['Fill recipients', 'kernelDev.series.fillRecipients'], ['Generate patches', 'kernelDev.series.generate']]);
		assert.strictEqual(base.command.command, 'kernelDev.series.pickBase', 'a click on Base picks a base');

		mock.state.config['kernelDev.patches.base'] = 'no-such-ref';
		await series.refresh();
		assert.ok(!series.info.mergeBase);
		assert.match(series.info.error, /does not exist here/);
		assert.deepStrictEqual(await view.getChildren(), [], 'the welcome view shows instead');
		mock.answer((items) => items.find(i => i === 'master'));
		await series.pickBase();
		assert.strictEqual(series.info.base, 'master');
		r.remove();
	});

	it('checks every commit and the working changes', async () => {
		const { r, c1, ctx, s } = seriesTree();
		const { series, view } = registerSeries(ctx, s);
		await series.checkSeries();
		assert.strictEqual(series.reports.size, 2);
		assert.strictEqual(series.reports.get(c1).warnings, 1);
		assert.strictEqual(series.lastBuild, 'skipped: configure a build in the Kernel tab for W=1');
		const commitsItem = (await view.getChildren()).find(i => i.label === 'Commits');
		const first = commitsItem.children[0];
		assert.strictEqual(first.description, '1/2 · 1 warning');
		assert.strictEqual(first.iconPath.id, 'warning');
		assert.match(first.tooltip.value, /long line/);
		await series.checkWorking();
		assert.strictEqual(series.working, null, 'no uncommitted changes');
		r.write('a.c', 'int a ;\n');
		await series.checkWorking();
		assert.strictEqual(series.working.errors, 0);
		await series.showReport(c1);
		assert.match(mock.state.log.pop().uri, /^untitled:/);
		r.remove();
	});

	it('summarizes results', () => {
		assert.deepStrictEqual(summary(undefined), { text: 'not checked', cls: '' });
		assert.deepStrictEqual(summary(null), { text: 'no changes', cls: '' });
		assert.deepStrictEqual(summary({ errors: 2, warnings: 1, checks: 0 }), { text: '2 errors, 1 warning', cls: 'error' });
		assert.deepStrictEqual(summary({ errors: 0, warnings: 0, checks: 0 }), { text: 'clean', cls: 'ok' });
		assert.strictEqual(statusIcon({ errors: 1 }).icon, 'error');
		assert.strictEqual(statusIcon({ errors: 0, warnings: 0, checks: 1 }).icon, 'warning');
		assert.strictEqual(statusIcon(undefined).icon, 'git-commit');
	});

	it('keeps the version per branch', async () => {
		const { r, ctx, s } = seriesTree();
		const { series } = registerSeries(ctx, s);
		await series.refresh();
		assert.strictEqual(series.version, 1);
		await mock.vscode.commands.executeCommand('kernelDev.series.nextVersion');
		assert.strictEqual(series.version, 2);
		await mock.vscode.commands.executeCommand('kernelDev.series.previousVersion');
		await mock.vscode.commands.executeCommand('kernelDev.series.previousVersion');
		assert.strictEqual(series.version, 1, 'never below v1');
		r.remove();
	});
});

describe('patches', () => {
	it('splits get_maintainer.pl output into To and Cc', () => {
		const { to, cc } = splitRecipients([
			'Maint One <one@example.com> (maintainer:FOO)',
			'Rev Two <two@example.com> (reviewer:FOO)',
			'list@vger.kernel.org (open list:FOO)',
			'Signer <s@example.com> (commit_signer:3/4=75%)',
			'no address here',
		].join('\n'));
		assert.deepStrictEqual(to, ['Maint One <one@example.com>', 'Rev Two <two@example.com>']);
		assert.deepStrictEqual(cc, ['list@vger.kernel.org', 'Signer <s@example.com>']);
	});

	it('fills and edits recipients, edits the cover letter and prefix', async () => {
		const { r, ctx, s } = seriesTree();
		const { series, patches } = registerSeries(ctx, s);
		await series.refresh();
		await patches.fillRecipients();
		assert.deepStrictEqual(patches.to, ['Maint One <one@example.com>', 'Rev Two <two@example.com>']);
		assert.deepStrictEqual(patches.cc, ['foo-list@vger.kernel.org', 'Someone <s@example.com>']);

		await patches.editRecipients();
		const file = [...patches.recipientFiles][0];
		assert.match(fs.readFileSync(file, 'utf8'), /^To:\nMaint One <one@example.com>\nRev Two/m);
		mock.events.onDidSaveTextDocument.fire({ uri: mock.vscode.Uri.file(file), getText: () => '# c\nTo:\na@x.org,\n\nCc:\nb@x.org\n' });
		await wait(() => patches.cc[0] === 'b@x.org');
		assert.deepStrictEqual([patches.to, patches.cc], [['a@x.org'], ['b@x.org']]);

		assert.strictEqual(await patches.cover(), '');
		await patches.editCover();
		const cover = [...patches.editing.keys()][0];
		assert.strictEqual(fs.readFileSync(cover, 'utf8'), COVER_TEMPLATE.trimEnd() + '\n');
		mock.events.onDidSaveTextDocument.fire({ uri: mock.vscode.Uri.file(cover), getText: () => 'foo: the subject\n\nThe body.\n' });
		await wait(() => r.git('config', '--get', 'branch.topic.description').trim() !== '');
		assert.strictEqual(await patches.cover(), 'foo: the subject\n\nThe body.');

		mock.answer('RFC PATCH net-next');
		await patches.editPrefix();
		assert.strictEqual(patches.prefix, 'RFC PATCH net-next');
		r.remove();
	});

	it('generates the series with git format-patch', async () => {
		const { r, ctx, s, c1 } = seriesTree();
		const { series, patches } = registerSeries(ctx, s);
		await series.refresh();
		r.git('config', 'branch.topic.description', 'foo: two files\n\nAdds a.c and b.c.');
		await patches.set('to', ['one@example.com']);
		await patches.set('cc', ['list@example.com']);
		await series.setVersion(2);
		await patches.generate();
		assert.deepStrictEqual(patches.output.files, ['v2-0000-cover-letter.patch', 'v2-0001-foo-add-a.c.patch', 'v2-0002-foo-add-b.c.patch']);
		const cover = fs.readFileSync(path.join(patches.output.dir, patches.output.files[0]), 'utf8');
		assert.match(cover, /^Subject: \[PATCH v2 0\/2\] foo: two files$/m);
		assert.match(cover, /^To: one@example.com$/m);
		assert.match(cover, /^Cc: list@example.com$/m);
		assert.match(cover, /^base-commit: [0-9a-f]{40}$/m);
		assert.match(fs.readFileSync(path.join(patches.output.dir, patches.output.files[1]), 'utf8'), new RegExp(`^From ${c1}`));
		// regenerating asks before replacing
		mock.answer(undefined);
		await patches.generate();
		assert.match(mock.state.log.filter(l => l.kind === 'warning').pop().message, /already has 3 patch files/);
		r.remove();
	});

	it('stops on checkpatch errors and a missing cover letter unless told to go on', async () => {
		const { r, ctx, s } = seriesTree({ checkpatchErrors: 1 });
		const { series, patches } = registerSeries(ctx, s);
		mock.answer(undefined);
		await patches.generate();
		assert.match(mock.state.log.filter(l => l.kind === 'warning').pop().message, /checkpatch reports 2 errors in 2 of 2 commits/);
		assert.strictEqual(patches.output, undefined, 'nothing written');
		mock.answer('Generate Anyway', 'Generate Anyway');
		await patches.generate();
		assert.match(mock.state.log.filter(l => l.kind === 'warning').pop().message, /cover letter has not been written/);
		assert.strictEqual(patches.output.files.length, 3);
		assert.match(fs.readFileSync(path.join(patches.output.dir, patches.output.files[0]), 'utf8'), /\*\*\* SUBJECT HERE \*\*\*/);
		r.remove();
	});
});

describe('send', () => {
	const dry = [
		'Dry-OK. Log says:', 'RCPT TO:<one@example.com>', 'RCPT TO:<list@example.com>', 'Subject: [PATCH 0/1] foo', '', 'Result: OK',
		'Dry-OK. Log says:', 'RCPT TO:<one@example.com>', 'Subject: [PATCH 1/1] foo: add', 'Result: OK',
	].join('\n');

	it('parses a dry run', () => {
		assert.deepStrictEqual(parseDryRun(dry), [
			{ subject: '[PATCH 0/1] foo', recipients: ['one@example.com', 'list@example.com'] },
			{ subject: '[PATCH 1/1] foo: add', recipients: ['one@example.com'] },
		]);
	});

	it('sends only after a dry run of exactly these files, after confirming', async () => {
		const { r, ctx, s } = seriesTree();
		const { series, patches, sender } = registerSeries(ctx, s);
		// git send-email stand-in on PATH: prints a dry run per file.
		const bin = tempDir();
		fs.writeFileSync(path.join(bin, 'git-send-email'), '#!/bin/sh\nfor f; do case $f in --*) ;; *) printf "Dry-OK. Log says:\\nRCPT TO:<a@x.org>\\nSubject: %s\\nResult: OK\\n" "$(basename $f)";; esac; done\n', { mode: 0o755 });
		process.env.PATH = `${bin}:${process.env.PATH}`;
		mock.state.config['kernelDev.checkpatch.strict'] = false;
		r.git('config', 'branch.topic.description', 'foo: x');
		r.git('config', 'sendemail.smtpServer', 'smtp.example.com');
		await series.refresh();
		await patches.generate();
		await sender.send();
		assert.match(mock.state.log.pop().message, /run a dry run of these exact files first/);
		await sender.dryRun();
		assert.ok(sender.dry.ok && sender.dryRunCurrent());
		assert.strictEqual(sender.smtp, 'smtp.example.com');
		mock.answer(undefined);
		await sender.send();
		assert.strictEqual(mock.state.terminals.length, 0, 'declined: nothing sent');
		mock.answer('Send');
		await sender.send();
		assert.deepStrictEqual(mock.state.terminals[0].options.shellArgs.slice(0, 3), ['send-email', '--confirm=never', '--suppress-cc=self']);
		assert.ok(!sender.dryRunCurrent(), 'a new send needs a new dry run');
		await sender.dryRun();
		fs.appendFileSync(sender.files()[0], '\n');
		assert.ok(!sender.dryRunCurrent(), 'editing a file invalidates the dry run');
		r.remove();
	});
});

describe('apply', () => {
	it('understands lore links and Message-IDs', () => {
		for (const s of ['https://lore.kernel.org/all/20260917.123-2-a@b.c/', 'https://patch.msgid.link/20260917.123-2-a@b.c',
			'<20260917.123-2-a@b.c>', 'https://lore.kernel.org/bpf/20260917.123-2-a@b.c/T/#u', '20260917.123-2-a@b.c'])
			assert.strictEqual(messageId(s), '20260917.123-2-a@b.c', s);
	});

	it('reads subjects from an mbox and b4 am output', () => {
		const mbox = 'From x Mon Sep 17 00:00:00 2001\nSubject: [PATCH 1/2] foo: one\n\nbody\nFrom y Mon Sep 17 00:00:00 2001\nSubject: [PATCH 2/2] foo: a long\n subject\n\nbody\n';
		assert.deepStrictEqual(mboxSubjects(mbox), ['[PATCH 1/2] foo: one', '[PATCH 2/2] foo: a long subject']);
		const b4 = [
			'  \x1b[32m✓\x1b[0m [PATCH v7 1/10] bpf: Make things killable',
			'    + Reviewed-by: John Doe <j@x.org> (✓ DKIM/x.org)',
			'    + Link: https://lore.kernel.org/r/abc',
			'  [PATCH v7 2/10] bpf: Second',
			' Link: https://lore.kernel.org/r/cover@x',
			' Base: using specified base-commit 0123456789abcdef0123456789abcdef01234567',
		].join('\n');
		const f = parseB4(b4, '/tmp/s.mbx', 'id@x');
		assert.deepStrictEqual(f.patches, ['[PATCH v7 1/10] bpf: Make things killable', '[PATCH v7 2/10] bpf: Second']);
		assert.deepStrictEqual(f.trailers, ['Reviewed-by: John Doe <j@x.org>']);
		assert.strictEqual(f.base, '0123456789abcdef0123456789abcdef01234567');
		assert.strictEqual(f.link, 'https://lore.kernel.org/r/cover@x');
		assert.strictEqual(parseB4(' Base: base-commit 0123456789ab not known, ignoring', 'x', 'y').base, undefined);
	});

	/** Patch files of the topic branch, and a fresh repo state to apply them to. */
	function patchesFor(r) {
		const out = tempDir();
		r.git('format-patch', '-q', '-o', out, '--base=base', 'base..topic');
		r.git('checkout', '-q', 'base');
		return fs.readdirSync(out).sort().map(f => mock.vscode.Uri.file(path.join(out, f)));
	}

	it('applies local patch files with git am, and resolves conflicts', async () => {
		const { r, ctx, s } = seriesTree();
		const files = patchesFor(r);
		const { apply, view } = registerApply(ctx, s);
		mock.answer(files);
		await apply.openFiles();
		assert.deepStrictEqual(apply.fetched.patches, ['[PATCH 1/2] foo: add a.c', '[PATCH 2/2] foo: add b.c']);
		assert.match(apply.fetched.baseNote, /^base-commit [0-9a-f]{12} from the patches$/);
		await apply.apply('current');
		assert.strictEqual(apply.message, 'Applied 2 patches.');
		assert.strictEqual(r.git('log', '-1', '--format=%s').trim(), 'foo: add b.c');

		// conflict: base gets a different a.c first
		r.git('checkout', '-q', '-b', 'conflict', 'base');
		r.commit('local a.c', { 'a.c': 'int local;\n' });
		await apply.apply('current');
		assert.deepStrictEqual([apply.am.next, apply.am.last], [1, 2]);
		assert.deepStrictEqual(apply.am.conflicts, ['a.c']);
		const tree = await view.getChildren();
		assert.deepStrictEqual((await view.getChildren(tree[0])).map(i => i.label), ['Continue', 'Skip this patch', 'Abort']);
		assert.match(tree[1].label, /^git am stopped at patch 1\/2$/);
		await apply.resolve('continue');
		assert.match(mock.state.log.pop().message, /conflict markers left in a\.c/);
		r.write('a.c', 'int a;\nint local;\n');
		await apply.resolve('continue');
		assert.strictEqual(apply.message, 'All patches applied.');
		assert.strictEqual(apply.am, undefined);

		// abort restores the branch
		r.git('checkout', '-q', '-b', 'abort-me', 'base');
		r.commit('local a.c', { 'a.c': 'int other;\n' });
		await apply.apply('current');
		await apply.resolve('abort');
		assert.strictEqual(r.git('log', '-1', '--format=%s').trim(), 'local a.c');
		r.remove();
	});

	it('applies on a new branch at the series\' base', async () => {
		const { r, ctx, s } = seriesTree();
		const files = patchesFor(r);
		r.commit('master moved on', { 'z.c': 'int z;\n' });
		const { apply } = registerApply(ctx, s);
		mock.answer(files);
		await apply.openFiles();
		mock.answer('review/foo');
		await apply.apply('newBranch');
		assert.strictEqual(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'review/foo');
		assert.strictEqual(r.git('log', '-1', '--format=%s', 'HEAD~2').trim(), 'scripts: add stand-ins', 'branched at the base-commit');
		r.remove();
	});

	it('fetches with b4 am and reports when b4 is missing', async () => {
		const { r, ctx, s } = seriesTree();
		const { apply } = registerApply(ctx, s);
		const bin = tempDir();
		fs.writeFileSync(path.join(bin, 'b4'), `#!/bin/sh
out=$3; shift 3
printf 'From x Mon Sep 17 00:00:00 2001\\nSubject: [PATCH] foo: fetched\\n\\nbody\\n' > "$out/v1_x.mbx"
echo "  [PATCH] foo: fetched"; echo "    + Acked-by: A <a@x.org>"; echo " Base: not specified"; echo "ARGS $*"
`, { mode: 0o755 });
		const PATH = process.env.PATH;
		process.env.PATH = `${bin}:${PATH}`;
		await apply.fetch('https://lore.kernel.org/r/123@x.org', { link: true, signoff: true });
		assert.deepStrictEqual(apply.fetched.patches, ['[PATCH] foo: fetched']);
		assert.deepStrictEqual(apply.fetched.trailers, ['Acked-by: A <a@x.org>']);
		assert.match(apply.fetched.log, /ARGS -l -s 123@x\.org/);
		process.env.PATH = '/nonexistent';
		await apply.fetch('123@x.org');
		process.env.PATH = PATH;
		assert.strictEqual(apply.message, 'b4 is not installed (Debian/Ubuntu: sudo apt install b4).');
		r.remove();
	});
});

describe('bisect', () => {
	function bisectRepo() {
		const r = makeRepo();
		const hashes = [];
		for (let i = 1; i <= 8; i++)
			hashes.push(r.commit(`step ${i}`, { 'v.txt': `${i}\n`, ...(i === 6 ? { 'bug.txt': 'bug\n' } : {}) }));
		return { r, hashes, bad: hashes[5] };
	}

	it('finds the first bad commit by marking steps', async () => {
		const { r, hashes, bad } = bisectRepo();
		const s = { root: r.dir, folder: { uri: mock.vscode.Uri.file(r.dir) }, get: (k, d) => d, configured: () => undefined, jobs: () => '-j2' };
		const { bisect, view } = registerBisect({ subscriptions: [], storageUri: mock.vscode.Uri.file(tempDir()) }, s);
		await bisect.start(hashes[7], hashes[0]);
		assert.ok(bisect.active && bisect.current);
		for (let i = 0; i < 10 && !bisect.result; i++)
			await bisect.step([fs.existsSync(path.join(r.dir, 'bug.txt')) ? 'bad' : 'good']);
		assert.strictEqual(bisect.result.hash, bad);
		assert.strictEqual(bisect.result.subject, 'step 6');
		const items = await view.getChildren();
		assert.ok(items.some(i => i.contextValue === 'result'));
		await mock.vscode.commands.executeCommand('kernelDev.bisect.copyFixes');
		assert.match(mock.state.clipboard, /\("step 6"\)$/);
		await bisect.reset();
		assert.ok(!bisect.active);
		await bisect.start('no-such', hashes[0]);
		assert.match(mock.state.log.pop().message, /"no-such" is not a commit/);
		r.remove();
	});

	it('runs git bisect run with a build-and-test wrapper', async () => {
		const { r, hashes, bad } = bisectRepo();
		const bin = tempDir();
		fs.writeFileSync(path.join(bin, 'make'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		process.env.PATH = `${bin}:${process.env.PATH}`;
		const buildDir = tempDir();
		const s = { root: r.dir, folder: { uri: mock.vscode.Uri.file(r.dir) }, get: (k, d) => d, jobs: () => '-j2',
			configured: () => ({ arch: 'x86_64', variant: 'debug', buildDir, makeArgs: [`O=${buildDir}`] }) };
		const { bisect } = registerBisect({ subscriptions: [], storageUri: mock.vscode.Uri.file(tempDir()) }, s);
		const script = path.join(tempDir(), 'test.sh');
		fs.writeFileSync(script, `#!/bin/sh\n[ "$1" = "${buildDir}" ] || exit 125\n[ -f bug.txt ] && exit 1\nexit 0\n`, { mode: 0o755 });
		await bisect.start(hashes[7], hashes[0]);
		await bisect.run(script);
		assert.strictEqual(bisect.message, `First bad commit: ${bad.slice(0, 12)} step 6`);
		await bisect.reset();
		r.remove();
	});
});

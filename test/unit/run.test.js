'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const mock = require('../helpers/vscode');
const { tempDir } = require('../helpers/repo');

const { Runner } = require('../../src/runner');
const { OopsWatcher, frames, decode, START } = require('../../src/oops');
const dt = require('../../src/dt');
const { failures, KUNIT_ARCH, registerKunit } = require('../../src/kunit');
const { KernelView, editOption, splitArgs, joinArgs, OPTIONS, registerKernelView } = require('../../src/kernelView');
const ui = require('../../src/ui');
const { Settings } = require('../../src/settings');
const { Kbuild } = require('../../src/kbuild');

function settings(root = tempDir()) {
	const ws = new Map();
	const ctx = { subscriptions: [], extensionPath: path.resolve(__dirname, '../..'), storageUri: mock.vscode.Uri.file(tempDir()),
		globalStorageUri: mock.vscode.Uri.file(tempDir()), workspaceState: { get: (k, d) => (ws.has(k) ? ws.get(k) : d), update: async (k, v) => ws.set(k, v) } };
	const s = new Settings(ctx, { uri: mock.vscode.Uri.file(root), name: 'linux', index: 0 });
	return { s, ctx, root };
}

function state(arch, buildDir = tempDir()) {
	return { arch, variant: 'debug', config: 'defconfig', buildDir, makeArgs: [`O=${buildDir}`, `ARCH=${arch}`, 'CROSS_COMPILE='], configuredAt: new Date().toISOString() };
}

describe('runner', () => {
	it('builds the QEMU command for each architecture', async () => {
		const { s, ctx } = settings();
		const r = new Runner(ctx, s, new Kbuild(s));
		mock.state.config['kernelDev.run.kvm'] = 'off';
		for (const [arch, qemu, image] of [['x86_64', 'qemu-system-x86_64', 'bzImage'], ['arm64', 'qemu-system-aarch64', 'Image'], ['riscv64', 'qemu-system-riscv64', 'Image']]) {
			const { cmd, args } = r.vmCommand(state(arch), false);
			assert.strictEqual(cmd, qemu);
			assert.ok(args[args.indexOf('-kernel') + 1].endsWith(image));
			assert.ok(!args.includes('-initrd'), 'no initramfs set');
			assert.ok(!args.includes('-S'));
			assert.ok(args.includes('-nographic') && args.some(a => /^stdio,id=kdcon,mux=on,signal=off,logfile=/.test(a)));
			assert.match(args[args.indexOf('-append') + 1], /^console=/);
		}
	});

	it('adds the gdbstub, nokaslr, initramfs, 9p share and extra arguments', async () => {
		const { s, ctx } = settings();
		const r = new Runner(ctx, s, new Kbuild(s));
		mock.state.config['kernelDev.run.initramfs'] = { x86_64: '/srv/x86.cpio.gz' };
		mock.state.config['kernelDev.run.shareBuildDir'] = true;
		mock.state.config['kernelDev.run.qemuArgs'] = ['-device', 'virtio-rng-pci'];
		mock.state.config['kernelDev.run.cmdline'] = 'loglevel=8';
		mock.state.config['kernelDev.run.kvm'] = 'on';
		mock.state.config['kernelDev.debug.port'] = 4321;
		const st = state('x86_64');
		const { args } = r.vmCommand(st, true);
		assert.strictEqual(args[args.indexOf('-initrd') + 1], '/srv/x86.cpio.gz');
		assert.strictEqual(args[args.indexOf('-append') + 1], 'console=ttyS0 nokaslr loglevel=8');
		assert.ok(args.includes('-enable-kvm'));
		assert.ok(args.join(' ').includes(`-virtfs local,path=${st.buildDir},mount_tag=kbuild,security_model=none,readonly=on`));
		assert.ok(args.join(' ').includes('-device virtio-rng-pci'));
		assert.ok(args.join(' ').endsWith('-gdb tcp:localhost:4321 -S'));
	});

	it('uses virtme-ng in virtme mode', () => {
		const { s, ctx } = settings();
		const r = new Runner(ctx, s, new Kbuild(s));
		mock.state.config['kernelDev.run.mode'] = 'virtme';
		mock.state.config['kernelDev.run.virtmeArgs'] = ['--verbose'];
		const { cmd, args } = r.vmCommand(state('arm64'), true);
		assert.strictEqual(cmd, 'vng');
		assert.deepStrictEqual(args.slice(0, 1), ['--run']);
		assert.ok(args.includes('--arch') && args.includes('arm64'));
		assert.ok(args.includes('--append') && args.includes('nokaslr'));
		assert.ok(args.join(' ').includes('--qemu-opts -gdb tcp:localhost:1234 -S'));
		assert.strictEqual(args[args.length - 1], '--verbose');
	});

	it('reports a missing initramfs instead of booting without it', async () => {
		const { s, ctx } = settings();
		const r = new Runner(ctx, s, new Kbuild(s));
		const st = state('x86_64');
		assert.strictEqual(await r.checkInitramfs(st), true, 'none set is fine');
		mock.state.config['kernelDev.run.initramfs'] = { x86_64: '/no/such.cpio' };
		assert.strictEqual(await r.checkInitramfs(st), false);
		assert.match(mock.state.log.pop().message, /does not exist/);
	});

	it('boots in a terminal, logs the console, and stops', async () => {
		const { s, ctx } = settings();
		const kb = new Kbuild(s);
		const r = new Runner(ctx, s, kb);
		const st = state('x86_64');
		let booted;
		r.onBoot = (log) => { booted = log; };
		r.boot(st, false);
		assert.strictEqual(mock.state.terminals.length, 1);
		assert.strictEqual(mock.state.terminals[0].options.shellPath, 'qemu-system-x86_64');
		assert.ok(r.running);
		assert.strictEqual(booted, path.join(st.buildDir, 'kernel-dev', 'console.log'));
		assert.ok(fs.existsSync(booted));
		r.stop();
		assert.ok(!r.running);
	});

	it('runs after building, and refuses without a kernel image', async () => {
		const { s, ctx } = settings();
		const kb = new Kbuild(s);
		kb.build = async () => 0;
		const r = new Runner(ctx, s, kb);
		await r.run();
		assert.match(mock.state.log.pop().message, /no .* kernel image/);
		const st = state(s.arch, s.buildDir());
		s.saveConfigured(st);
		fs.mkdirSync(path.dirname(kb.image(st)), { recursive: true });
		fs.writeFileSync(kb.image(st), 'kernel');
		await r.run();
		assert.strictEqual(mock.state.terminals.length, 1);
		kb.build = async () => 2;
		await r.run();
		assert.match(mock.state.log.pop().message, /build failed/);
	});

	it('makes debug configurations for cpptools, Native Debug and CodeLLDB', () => {
		const { s, ctx } = settings();
		const r = new Runner(ctx, s, new Kbuild(s));
		mock.state.config['kernelDev.debug.gdbCommands'] = ['set print elements 0'];
		const st = state('arm64');
		const cpp = r.debugConfiguration(st, 'cppdbg', 1234);
		assert.strictEqual(cpp.type, 'cppdbg');
		assert.strictEqual(cpp.miDebuggerServerAddress, 'localhost:1234');
		assert.strictEqual(cpp.program, path.join(st.buildDir, 'vmlinux'));
		assert.ok(cpp.setupCommands.some(c => c.text === `add-auto-load-safe-path ${st.buildDir}`));
		assert.ok(cpp.setupCommands.some(c => c.text === 'set print elements 0'));
		const gdb = r.debugConfiguration(st, 'gdb', 99);
		assert.strictEqual(gdb.type, 'gdb');
		assert.strictEqual(gdb.target, 'localhost:99');
		const lldb = r.debugConfiguration(st, 'lldb', 5);
		assert.deepStrictEqual(lldb.processCreateCommands, ['gdb-remote localhost:5']);
	});

	it('picks the installed debugger and offers to install one', async () => {
		const { s, ctx } = settings();
		const r = new Runner(ctx, s, new Kbuild(s));
		assert.strictEqual(r.debuggerFlavor(), 'cppdbg');
		mock.state.extensions = { 'webfreak.debug': {} };
		assert.strictEqual(r.debuggerFlavor(), 'gdb');
		mock.state.config['kernelDev.debug.debugger'] = 'lldb';
		assert.strictEqual(r.debuggerFlavor(), 'lldb');
		assert.strictEqual(await r.checkDebugger('lldb'), false);
		assert.match(mock.state.log.pop().message, /vadimcn.vscode-lldb/);
		assert.strictEqual(await r.checkDebugger('gdb'), true);
	});

	it('hands over to the IDE debugger once the guest is at the symbol', async function () {
		const { s, ctx } = settings();
		const kb = new Kbuild(s);
		const r = new Runner(ctx, s, kb);
		const st = state(s.arch, s.buildDir());
		r.checkDebugger = async () => true;
		r.prepare = async () => st;
		r.boot = () => {};
		// A gdbstub stand-in that accepts the connection.
		const server = net.createServer(sock => sock.end()).listen(0);
		await new Promise(res => server.once('listening', res));
		const port = server.address().port;
		mock.state.config['kernelDev.debug.port'] = port;
		mock.state.config['kernelDev.debug.breakAt'] = '';
		await r.debug();
		server.close();
		assert.strictEqual(mock.state.debugSessions.length, 1);
		assert.strictEqual(mock.state.debugSessions[0].miDebuggerServerAddress, `localhost:${port}`);
	});

	it('asks before debugging a Release build', async () => {
		const { s, ctx } = settings();
		const r = new Runner(ctx, s, new Kbuild(s));
		await s.select('variant', 'release');
		mock.answer(undefined);
		await r.debug();
		assert.match(mock.state.log.pop().message, /Release build has no debug info/);
		assert.strictEqual(mock.state.debugSessions.length, 0);
	});
});

describe('oops', () => {
	const trace = [
		'[    7.765285] sysrq: Trigger a crash',
		'[    7.765288] Kernel panic - not syncing: sysrq triggered crash',
		'[    7.768143] Call Trace:',
		'[    7.768643]  dump_stack_lvl (lib/dump_stack.c:94 lib/dump_stack.c:120)',
		'[    7.769682]  sysrq_handle_crash (drivers/tty/sysrq.c:154)',
		'[    7.771715]  ? handle_mm_fault (mm/memory.c:6876)',
		'[    7.771800]  foo+0x10/0x20 [mymod] (drivers/mine/foo.c:12)',
		'[    7.780000] ---[ end Kernel panic - not syncing: sysrq triggered crash ]---',
	].join('\n');

	it('recognizes crash reports', () => {
		for (const l of ['Oops: 0002 [#1] SMP', 'BUG: kernel NULL pointer dereference', 'WARNING: CPU: 0 PID: 1 at x', 'general protection fault', 'Kernel panic - not syncing: x',
			'[    1.234567][    T1] WARNING: kernel/fork.c:12 at f+0x1/0x2, CPU#0'])
			assert.ok(START.test(l), l);
		assert.ok(!START.test('[    1.0] Run /init as init process'));
		assert.ok(!START.test('[    0.1] Speculative Return Stack Overflow: WARNING: See https://kernel.org/doc/html/latest/admin-guide/hw-vuln/srso.html for mitigation options.'));
	});

	it('parses decoded frames, innermost location first, marking "?" frames', () => {
		const f = frames(trace);
		assert.deepStrictEqual(f.map(x => [x.func, x.file, x.line, x.reliable]), [
			['dump_stack_lvl', 'lib/dump_stack.c', 94, true],
			['sysrq_handle_crash', 'drivers/tty/sysrq.c', 154, true],
			['handle_mm_fault', 'mm/memory.c', 6876, false],
			['foo', 'drivers/mine/foo.c', 12, true],
		]);
	});

	it('follows a console log and reports a crash as it is written', async () => {
		const dir = tempDir();
		const log = path.join(dir, 'console.log');
		fs.writeFileSync(log, 'booting\n');
		const w = new OopsWatcher(dir);
		let found;
		w.found = async (text) => { found = text; };
		w.watch(log, state('x86_64'));
		for (const chunk of trace.match(/[\s\S]{1,60}/g)) {
			fs.appendFileSync(log, chunk);
			await new Promise(r => setTimeout(r, 30));
		}
		fs.appendFileSync(log, '\n');
		for (let i = 0; i < 40 && !found; i++)
			await new Promise(r => setTimeout(r, 100));
		w.stop();
		assert.ok(found, 'crash reported');
		assert.match(found, /^\[ +7\.765288\] Kernel panic/);
		assert.match(found, /end Kernel panic/);
	});

	it('shows a decoded report with links, and frames in Problems', async () => {
		const dir = tempDir();
		fs.mkdirSync(path.join(dir, 'drivers/tty'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'drivers/tty/sysrq.c'), 'x\n');
		fs.mkdirSync(path.join(dir, 'scripts'));
		// decode_stacktrace.sh stand-in: prints its input unchanged.
		fs.writeFileSync(path.join(dir, 'scripts/decode_stacktrace.sh'), '#!/bin/bash\ncat\n');
		const w = new OopsWatcher(dir);
		const res = await w.show(trace, state('x86_64'), 'panic');
		assert.strictEqual(res.frames.length, 4);
		const diags = [...mock.state.diagnostics].filter(([k]) => k.startsWith('kernel oops|'));
		assert.strictEqual(diags.reduce((n, [, d]) => n + d.length, 0), 3, 'the "?" frame is left out');
		const report = w.reports.get('1');
		const lines = report.split('\n');
		const links = w.provideDocumentLinks({ lineCount: lines.length, lineAt: (i) => ({ text: lines[i] }) });
		assert.strictEqual(links.length, 1, 'only files that exist become links');
		assert.strictEqual(links[0].target.fragment, 'L154');
		assert.match(w.provideTextDocumentContent(mock.vscode.Uri.parse('kernel-oops:/1/panic.oops')), /^panic\n/);
		w.diagnostics.dispose();
	});

	it('passes LLVM and CROSS_COMPILE to decode_stacktrace.sh', async () => {
		const dir = tempDir();
		fs.mkdirSync(path.join(dir, 'scripts'));
		fs.writeFileSync(path.join(dir, 'scripts/decode_stacktrace.sh'), '#!/bin/bash\necho "LLVM=$LLVM CROSS=$CROSS_COMPILE ARGS=$*"\n');
		const st = { ...state('arm64'), makeArgs: ['O=x', 'LLVM=1', 'CROSS_COMPILE=aarch64-linux-gnu-'] };
		const out = await decode(dir, st, 'x');
		assert.strictEqual(out.trim(), `LLVM=1 CROSS=aarch64-linux-gnu- ARGS=${path.join(st.buildDir, 'vmlinux')} ${dir}`);
	});
});

describe('devicetree', () => {
	it('maps changed files to dtbs and schemas', () => {
		const root = tempDir();
		const d = path.join(root, 'arch/arm64/boot/dts/arm');
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'juno.dts'), '#include "juno-base.dtsi"\n');
		fs.writeFileSync(path.join(d, 'juno-r1.dts'), '#include "juno-base.dtsi"\n');
		fs.writeFileSync(path.join(d, 'other.dts'), '/ {};\n');
		const t = dt.targets(root, 'arm64', ['arch/arm64/boot/dts/arm/juno-base.dtsi', 'arch/arm64/boot/dts/arm/other.dts',
			'Documentation/devicetree/bindings/serial/8250.yaml', 'drivers/x.c']);
		assert.deepStrictEqual(t.dtbs, ['arm/juno-r1.dtb', 'arm/juno.dtb', 'arm/other.dtb']);
		assert.deepStrictEqual(t.schemas, ['serial/8250.yaml']);
	});

	it('parses dtc, yamllint and dt-schema output', () => {
		const root = tempDir();
		const dts = path.join(root, 'arch/arm64/boot/dts/arm/juno.dts');
		fs.mkdirSync(path.dirname(dts), { recursive: true });
		fs.writeFileSync(dts, '/ {\n\tsoc {\n\t\tbogus@1000 {\n\t\t};\n\t};\n};\n');
		const out = [
			'arch/arm64/boot/dts/arm/juno.dts:3.3-4.5: Warning (unit_address_vs_reg): /soc/bogus@1000: node has a unit name, but no reg',
			`Error: ${dts}:20.2-44 Properties must precede subnodes`,
			'Documentation/devicetree/bindings/serial/8250.yaml:7:9: [warning] too many spaces after colon (colons)',
			`${path.join('/build', 'arch/arm64/boot/dts/arm/juno')}.dtb: /soc/bogus@1000: failed to match any schema with compatible: ['acme,x']`,
			'arch/arm64/boot/dts/arm/juno.dtb: / (arm,juno): bogus@1000: \'anyOf\' conditional failed',
		].join('\n');
		const f = dt.parse(out, root, '/build');
		assert.deepStrictEqual(f.map(x => [x.file, x.line, x.severity]), [
			['arch/arm64/boot/dts/arm/juno.dts', 3, 'warning'],
			['arch/arm64/boot/dts/arm/juno.dts', 20, 'error'],
			['Documentation/devicetree/bindings/serial/8250.yaml', 7, 'warning'],
			['arch/arm64/boot/dts/arm/juno.dts', 3, 'warning'],
			['arch/arm64/boot/dts/arm/juno.dts', 3, 'warning'],
		]);
		assert.strictEqual(dt.nodeLine(dts, 'no node here'), 1);
	});

	it('explains why it skips', async () => {
		const { s } = settings();
		const checks = new dt.DtChecks(s);
		s.configured = () => undefined;
		assert.match(await checks.check(['a.dts']), /configure a build/);
		s.configured = () => state('x86_64');
		assert.match(await checks.check(['a.dts']), /do not use devicetree/);
	});
});

describe('kunit', () => {
	it('extracts failure details and locations from kunit.py output', () => {
		const out = [
			'[10:01:20] ============ example (3 subtests) ============',
			'[10:01:20] [PASSED] example_skip_test',
			'[10:01:20]     # example_simple_test: initializing',
			'[10:01:20]     # example_simple_test: EXPECTATION FAILED at lib/kunit/kunit-example-test.c:30',
			'[10:01:20]     Expected 1 + 1 == 3, but',
			'[10:01:20] [FAILED] example_simple_test',
			'[10:01:20] [FAILED] no_location_test',
		].join('\n');
		const f = failures(out);
		assert.deepStrictEqual([f.get('example_simple_test').file, f.get('example_simple_test').line], ['lib/kunit/kunit-example-test.c', 30]);
		assert.match(f.get('example_simple_test').log, /Expected 1 \+ 1 == 3/);
		assert.strictEqual(f.get('no_location_test').file, undefined);
	});

	it('maps architectures to kunit.py names', () => {
		assert.deepStrictEqual(KUNIT_ARCH, { x86_64: 'x86_64', arm64: 'arm64', riscv64: 'riscv' });
	});

	it('builds the kunit.py command, runs it and reports results', async () => {
		const { s, ctx, root } = settings();
		mock.state.config['kernelDev.kunit.kunitconfig'] = 'lib/kunit';
		const k = registerKunit(ctx, s);
		// A kunit.py stand-in: writes JSON results and prints a failure.
		fs.mkdirSync(path.join(root, 'tools/testing/kunit'), { recursive: true });
		fs.writeFileSync(path.join(root, 'tools/testing/kunit/kunit.py'), `
import json, sys
out = [a.split('=', 1)[1] for a in sys.argv if a.startswith('--json=')][0]
json.dump({'name': 'all', 'sub_groups': [{'name': 'suite', 'test_cases': [{'name': 'ok', 'status': 'PASS'}, {'name': 'bad', 'status': 'FAIL'}, {'name': 'sk', 'status': 'SKIP'}]}]}, open(out, 'w'))
print('    # bad: EXPECTATION FAILED at lib/x.c:7')
print('[FAILED] bad')
print('ARGS', ' '.join(sys.argv[1:]))
sys.exit(1)
`);
		await k.run(new mock.vscode.TestRunRequest(), new mock.vscode.CancellationTokenSource().token);
		const run = mock.state.testRuns.pop();
		const r = Object.fromEntries(run.results.map(x => [x[1], x[0]]));
		assert.deepStrictEqual(r, { 'suite.ok': 'passed', 'suite.bad': 'failed', 'suite.sk': 'skipped' });
		const failed = run.results.find(x => x[0] === 'failed')[2];
		assert.strictEqual(failed.location.range.start.line, 6);
		const task = mock.state.tasks.pop();
		assert.match(task.execution.args[1], /kunit\.py run --arch=\w+ --build_dir=\S+ .*--kunitconfig=lib\/kunit 2>&1/);
		// the tree now lists the suite and its cases
		assert.ok(k.find('suite.bad'));
		// filtered run of one suite
		await k.run(new mock.vscode.TestRunRequest([k.find('suite')]), new mock.vscode.CancellationTokenSource().token);
		assert.match(mock.state.tasks.pop().execution.args[1], / suite 2>&1/);
	});
});

describe('kernel view and pickers', () => {
	function view() {
		const { s, ctx } = settings();
		const kb = new Kbuild(s);
		const runner = new Runner(ctx, s, kb);
		const v = registerKernelView(ctx, s, kb, runner);
		return { s, v, runner, kb };
	}
	const labels = async (v, item) => Promise.all((await v.getChildren(item)).map(async i => `${i.label}${i.description ? ` — ${i.description}` : ''}`));

	it('shows the steps, more actions, target, status and options', async () => {
		const { v, s, runner } = view();
		const [steps, more, target, status, options] = await v.getChildren();
		assert.deepStrictEqual([steps.label, more.label, target.label, status.label, options.label], ['Steps', 'More', 'Target', 'Status', 'Options']);
		const rows = await v.getChildren(steps);
		assert.deepStrictEqual(rows.map(r => [r.label, r.command.command]), [['Configure', 'kernelDev.configure'], ['Build', 'kernelDev.build'],
			['Run', 'kernelDev.run'], ['Debug', 'kernelDev.debug']]);
		assert.match(rows[1].description, /not configured yet/);
		assert.ok((await v.getChildren(more)).every(r => r.command && r.contextValue === 'step'));
		Object.defineProperty(runner, 'running', { value: true, configurable: true });
		assert.deepStrictEqual((await v.getChildren((await v.getChildren())[0])).map(r => r.label), ['Configure', 'Build', 'Stop VM']);
		delete runner.running;
		const arch = (await v.getChildren(target))[0];
		assert.deepStrictEqual([arch.command.command, arch.command.arguments[0]], ['kernelDev.editItem', arch], 'a click changes the value');
		assert.deepStrictEqual(await labels(v, target), [`Architecture — ${s.arch}${require('../../src/arch').isNative(s.arch) ? '' : ' (cross)'}`, 'Build — Debug', 'Base config — defconfig']);
		assert.deepStrictEqual((await labels(v, status)).slice(0, 3), ['Configured — not yet', 'Built — not yet', 'VM — stopped']);
		assert.strictEqual((await v.getChildren(options)).length, OPTIONS.length);
		v.setTools('build: flex', 'sudo apt-get install flex', ['flex (flex)']);
		const tools = (await v.getChildren((await v.getChildren())[3])).find(i => i.label === 'Tools');
		assert.strictEqual(tools.contextValue, 'toolsMissing');
	});

	it('edits each kind of option', async () => {
		const { s } = view();
		const opt = (key) => OPTIONS.find(o => o.key === key);
		mock.answer((items) => items.find(i => i.value === 'llvm'));
		await editOption(s, opt('toolchain'));
		assert.strictEqual(mock.state.config['kernelDev.toolchain'], 'llvm');
		await editOption(s, opt('make.ccache'));
		assert.strictEqual(mock.state.config['kernelDev.make.ccache'], true);
		mock.answer('W=1 "KCFLAGS=-Og -g"');
		await editOption(s, opt('make.args'));
		assert.deepStrictEqual(mock.state.config['kernelDev.make.args'], ['W=1', 'KCFLAGS=-Og -g']);
		mock.answer('CONFIG_KASAN=y LOCALVERSION="-x"');
		await editOption(s, opt('configure.options'));
		assert.deepStrictEqual(mock.state.config['kernelDev.configure.options'], { KASAN: 'y', LOCALVERSION: '-x' });
		mock.answer('4');
		await editOption(s, opt('run.smp'));
		assert.strictEqual(mock.state.config['kernelDev.run.smp'], 4);
		mock.answer('my-');
		await editOption(s, opt('crossCompile'));
		assert.deepStrictEqual(mock.state.config['kernelDev.crossCompile'], { [s.arch]: 'my-' });
		mock.answer((items) => items[0], [mock.vscode.Uri.file('/srv/i.cpio')]);
		await editOption(s, opt('run.initramfs'));
		assert.deepStrictEqual(mock.state.config['kernelDev.run.initramfs'], { [s.arch]: '/srv/i.cpio' });
		mock.answer((items) => items[1]);
		await editOption(s, opt('run.initramfs'));
		assert.deepStrictEqual(mock.state.config['kernelDev.run.initramfs'], {});
		mock.answer(undefined);
		await editOption(s, opt('run.cmdline'));
		assert.strictEqual(mock.state.config['kernelDev.run.cmdline'], undefined, 'cancel leaves it alone');
	});

	it('splits and joins arguments with quotes', () => {
		assert.deepStrictEqual(splitArgs(`W=1 "CC=ccache gcc" 'a b' x\\"y`), ['W=1', 'CC=ccache gcc', 'a b', 'x\\"y']);
		assert.strictEqual(joinArgs(['W=1', 'CC=ccache gcc']), 'W=1 "CC=ccache gcc"');
	});

	it('picks architecture, variant and base config', async () => {
		const { s } = view();
		mock.answer((items) => items.find(i => i.label === 'riscv64'));
		await ui.pickArch(s);
		assert.strictEqual(s.arch, 'riscv64');
		mock.answer((items) => items.find(i => i.value === 'release'));
		await ui.pickVariant(s);
		assert.strictEqual(s.variant, 'release');
		mock.answer((items) => items.find(i => i.label === 'tinyconfig'));
		await ui.pickConfig(s);
		assert.strictEqual(s.config, 'tinyconfig');
		mock.answer((items) => items[items.length - 1], [mock.vscode.Uri.file('/tmp/my.config')]);
		await ui.pickConfig(s);
		assert.strictEqual(s.config, '/tmp/my.config');
		assert.ok(ui.listConfigs(s).some(c => c.value === '/tmp/my.config' && c.description === 'current'));
	});
});

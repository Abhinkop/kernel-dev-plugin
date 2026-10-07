'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('../helpers/vscode');
const { makeRepo, tempDir } = require('../helpers/repo');

const { ARCHES, archInfo, isNative } = require('../../src/arch');
const { Settings } = require('../../src/settings');
const tools = require('../../src/tools');
const { sq, makeTask, runTask } = require('../../src/tasks');
const { Kbuild } = require('../../src/kbuild');
const { updateCompileCommands } = require('../../src/clangd');

/** A Settings over a temp kernel-like tree with workspace state in memory. */
function settings(root = tempDir()) {
	const ws = new Map();
	const ctx = { subscriptions: [], workspaceState: { get: (k, d) => (ws.has(k) ? ws.get(k) : d), update: async (k, v) => ws.set(k, v) } };
	const s = new Settings(ctx, { uri: mock.vscode.Uri.file(root), name: 'linux', index: 0 });
	return { s, ws, root };
}

describe('arch', () => {
	it('describes every supported architecture', () => {
		assert.deepStrictEqual(Object.keys(ARCHES), ['x86_64', 'arm64', 'riscv64']);
		assert.strictEqual(archInfo('riscv64').kernelArch, 'riscv');
		assert.strictEqual(archInfo('arm64').image, 'arch/arm64/boot/Image');
		assert.strictEqual(archInfo('x86_64').console, 'ttyS0');
	});
	it('rejects unknown architectures', () => {
		assert.throws(() => archInfo('mips'), /Unsupported architecture "mips"/);
	});
	it('knows which architecture is native', () => {
		const native = { x64: 'x86_64', arm64: 'arm64', riscv64: 'riscv64' }[os.arch()];
		for (const a of Object.keys(ARCHES))
			assert.strictEqual(isNative(a), a === native);
	});
});

describe('settings', () => {
	it('defaults the selection to the host architecture, Debug and defconfig', () => {
		const { s } = settings();
		assert.ok(Object.keys(ARCHES).includes(s.arch));
		assert.strictEqual(s.variant, 'debug');
		assert.strictEqual(s.config, 'defconfig');
	});

	it('keeps the selection per workspace, the base config per architecture', async () => {
		const { s } = settings();
		let fired = 0;
		s.onDidChange(() => fired++);
		await s.select('arch', 'arm64');
		await s.select('config', 'tinyconfig');
		await s.select('variant', 'release');
		assert.strictEqual(s.arch, 'arm64');
		assert.strictEqual(s.variant, 'release');
		assert.strictEqual(s.config, 'tinyconfig');
		await s.select('arch', 'riscv64');
		assert.strictEqual(s.config, 'defconfig', 'riscv64 has its own base config');
		assert.strictEqual(fired, 4);
	});

	it('ignores unknown stored values', async () => {
		const { s, ws } = settings();
		ws.set('kernelDev.arch', 'sparc');
		ws.set('kernelDev.variant', 'profile');
		assert.ok(Object.keys(ARCHES).includes(s.arch));
		assert.strictEqual(s.variant, 'debug');
	});

	it('derives the build directory from the template', async () => {
		const { s, root } = settings();
		await s.select('arch', 'arm64');
		assert.strictEqual(s.buildDir(), path.join(root, 'build/arm64/debug'));
		mock.state.config['kernelDev.buildDirectory'] = '/out/${variant}-${arch}';
		assert.strictEqual(s.buildDir('x86_64', 'release'), '/out/release-x86_64');
	});

	it('builds the make arguments for GCC, cross GCC, LLVM and ccache', async () => {
		const { s } = settings();
		const cross = isNative('arm64') ? 'riscv64' : 'arm64';
		await s.select('arch', cross);
		let a = s.makeArgsForConfigure();
		assert.ok(a[0].startsWith('O='));
		assert.ok(a.includes(`ARCH=${archInfo(cross).kernelArch}`));
		assert.ok(a.includes(`CROSS_COMPILE=${archInfo(cross).gccPrefix}`));

		mock.state.config['kernelDev.crossCompile'] = { [cross]: 'my-prefix-' };
		mock.state.config['kernelDev.make.ccache'] = true;
		a = s.makeArgsForConfigure();
		assert.ok(a.includes('CROSS_COMPILE=my-prefix-'));
		assert.ok(a.includes('CC=ccache my-prefix-gcc'));

		mock.state.config['kernelDev.toolchain'] = 'llvm';
		mock.state.config['kernelDev.make.args'] = ['W=1'];
		a = s.makeArgsForConfigure();
		assert.deepStrictEqual(a.slice(2), ['LLVM=1', 'CROSS_COMPILE=', 'CC=ccache clang', 'W=1']);
	});

	it('uses all CPUs unless jobs is set', () => {
		const { s } = settings();
		assert.strictEqual(s.jobs(), `-j${os.cpus().length}`);
		mock.state.config['kernelDev.make.jobs'] = 3;
		assert.strictEqual(s.jobs(), '-j3');
	});

	it('records and reads back what Configure used', () => {
		const { s } = settings();
		assert.strictEqual(s.configured(), undefined);
		const state = { arch: s.arch, variant: 'debug', config: 'defconfig', buildDir: s.buildDir(), makeArgs: ['O=x'], configuredAt: 'now' };
		s.saveConfigured(state);
		assert.deepStrictEqual(s.configured(), state);
		s.clearConfigured();
		assert.strictEqual(s.configured(), undefined);
	});

	it('picks gdb or gdb-multiarch', async () => {
		const { s } = settings();
		const native = Object.keys(ARCHES).find(isNative);
		if (native) {
			await s.select('arch', native);
			assert.strictEqual(s.gdbPath(), 'gdb');
		}
		await s.select('arch', Object.keys(ARCHES).find(a => !isNative(a)));
		assert.strictEqual(s.gdbPath(), 'gdb-multiarch');
		mock.state.config['kernelDev.debug.gdb'] = '/opt/gdb';
		assert.strictEqual(s.gdbPath(), '/opt/gdb');
	});
});

describe('tools', () => {
	it('needs the compiler of the toolchain', () => {
		const names = (args) => tools.buildRequirements(args).map(r => r.what);
		assert.ok(names(['CROSS_COMPILE=']).includes('gcc'));
		assert.ok(names(['CROSS_COMPILE=aarch64-linux-gnu-']).includes('aarch64-linux-gnu-gcc'));
		assert.ok(names(['CROSS_COMPILE=aarch64-linux-gnu-']).includes('gcc'), 'host gcc for scripts/');
		const llvm = names(['LLVM=1', 'CROSS_COMPILE=']);
		assert.ok(['clang', 'ld.lld', 'llvm-ar'].every(t => llvm.includes(t)));
		assert.ok(!llvm.includes('gcc'));
		assert.ok(names(['CROSS_COMPILE=', 'CC=ccache gcc']).includes('ccache'));
	});

	it('names the QEMU package for each architecture and distro', () => {
		tools.aptKnows.set('qemu-system-riscv', true);
		assert.strictEqual(tools.qemuPackage('riscv64'), 'qemu-system-riscv', 'split out since QEMU 10 packaging');
		tools.aptKnows.set('qemu-system-riscv', false);
		assert.strictEqual(tools.qemuPackage('riscv64'), 'qemu-system-misc', 'older Debian/Ubuntu');
		tools.aptKnows.clear();
		assert.strictEqual(tools.qemuPackage('arm64'), 'qemu-system-arm');
		assert.strictEqual(tools.qemuPackage('x86_64'), 'qemu-system-x86');
	});

	it('names packages and builds one install command', () => {
		const reqs = [
			{ step: 'build', what: 'flex', pkg: 'flex', present: () => false },
			{ step: 'run', what: 'qemu-system-arm', pkg: 'qemu-system-arm', present: () => false },
			{ step: 'run', what: 'initramfs x', hint: 'fix kernelDev.run.initramfs', present: () => false },
		];
		assert.strictEqual(tools.describe(reqs), 'build: flex · run: qemu-system-arm, initramfs x (fix kernelDev.run.initramfs)');
		const cmd = tools.installCommand(reqs);
		if (tools.onPath('apt-get'))
			assert.strictEqual(cmd, 'sudo apt-get install flex qemu-system-arm');
		else
			assert.strictEqual(cmd, '');
	});

	it('covers run, debug, git and the optional checks', async () => {
		const { s } = settings();
		s.configured = () => undefined;
		let what = tools.requirements(s).map(r => r.what);
		assert.ok(what.includes(archInfo(s.arch).qemu));
		assert.ok(what.includes('git') && what.includes('b4'));
		assert.ok(!what.includes('sparse'));
		mock.state.config['kernelDev.check.sparse'] = true;
		mock.state.config['kernelDev.check.coccinelle'] = true;
		mock.state.config['kernelDev.run.mode'] = 'virtme';
		mock.state.config['kernelDev.run.initramfs'] = { [s.arch]: '/no/such/file' };
		what = tools.requirements(s).map(r => r.what);
		assert.ok(['sparse', 'spatch', 'ocamlopt', 'vng'].every(t => what.includes(t)));
		mock.state.config['kernelDev.run.mode'] = 'qemu';
		const missing = tools.missing(s).map(r => r.what);
		assert.ok(missing.includes('initramfs /no/such/file'));
	});

	it('finds programs on PATH', () => {
		assert.ok(tools.onPath('sh'));
		assert.ok(!tools.onPath('no-such-program-kwb'));
		assert.ok(tools.onPath('/bin/sh'));
	});
});

describe('tasks', () => {
	it('quotes for the shell', () => {
		assert.strictEqual(sq('make'), 'make');
		assert.strictEqual(sq('O=/a b'), "'O=/a b'");
		assert.strictEqual(sq("it's"), "'it'\\''s'");
	});

	it('runs a process as a task and returns its exit code', async () => {
		const folder = { uri: mock.vscode.Uri.file(os.tmpdir()) };
		assert.strictEqual(await runTask(folder, 'ok', 'sh', ['-c', 'exit 0']), 0);
		assert.strictEqual(await runTask(folder, 'fail', 'sh', ['-c', 'exit 3']), 3);
	});

	it('closes the terminal of a step that succeeded, and keeps a failed one', async () => {
		const folder = { uri: mock.vscode.Uri.file(os.tmpdir()) };
		const t = makeTask(folder, 'x', 'true', []);
		assert.strictEqual(t.presentationOptions.close, false, 'VS Code would close it even on failure');
		assert.strictEqual(t.source, 'kernel');
		const open = () => mock.vscode.window.terminals.map(x => x.name);
		await runTask(folder, 'good', 'sh', ['-c', 'exit 0']);
		await runTask(folder, 'bad', 'sh', ['-c', 'exit 2']);
		assert.deepStrictEqual(open(), ['bad']);
		mock.state.config['kernelDev.terminal.afterTask'] = 'keep';
		await runTask(folder, 'kept', 'sh', ['-c', 'exit 0']);
		assert.deepStrictEqual(open(), ['bad', 'kept']);
		for (const legacy of ['waitForKey', 'close']) {
			mock.state.config['kernelDev.terminal.afterTask'] = legacy;
			await runTask(folder, legacy, 'sh', ['-c', 'exit 0']);
			assert.ok(!open().includes(legacy), `${legacy} closes on success`);
		}
	});
});

describe('kbuild', () => {
	/** Kbuild over a fake tree whose "make" and "scripts/config" just log. */
	function fake() {
		const repo = makeRepo();
		const root = repo.dir;
		const bin = path.join(root, '.bin');
		fs.mkdirSync(bin);
		const log = path.join(root, 'make.log');
		fs.writeFileSync(path.join(bin, 'make'), `#!/bin/sh\necho "make $*" >> ${log}\nfor a; do case $a in O=*) mkdir -p "\${a#O=}"; touch "\${a#O=}/.config";; esac; done\n`, { mode: 0o755 });
		fs.mkdirSync(path.join(root, 'scripts'));
		fs.writeFileSync(path.join(root, 'scripts', 'config'), `#!/bin/sh\necho "config $*" >> ${log}\n[ "$3" = "-s" ] && echo y\nexit 0\n`, { mode: 0o755 });
		process.env.PATH = `${bin}:${process.env.PATH}`;
		const { s } = settings(root);
		const kb = new Kbuild(s);
		kb.checkTools = () => true;
		return { repo, root, s, kb, log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
	}

	it('configures: base config, options, olddefconfig, and records the arguments', async () => {
		const { s, kb, log, repo } = fake();
		mock.state.config['kernelDev.configure.options'] = { KASAN: 'y', LOG_BUF_SHIFT: '18', LOCALVERSION: '-test' };
		assert.strictEqual(await kb.configure(), 0);
		const l = log();
		assert.match(l, /make O=\S+ ARCH=\S+ .*defconfig/);
		assert.match(l, /config --file \S+\.config .*-e DEBUG_KERNEL .*-e GDB_SCRIPTS .*-e KASAN --set-val LOG_BUF_SHIFT 18 --set-str LOCALVERSION -test/);
		assert.match(l, /olddefconfig/);
		const st = s.configured();
		assert.strictEqual(st.config, 'defconfig');
		assert.ok(st.makeArgs[0].startsWith('O='));
		repo.remove();
	});

	it('uses Release options and a .config file as the base', async () => {
		const { s, kb, log, root, repo } = fake();
		await s.select('variant', 'release');
		fs.writeFileSync(path.join(root, 'my.config'), 'CONFIG_X=y\n');
		await s.select('config', 'my.config');
		assert.strictEqual(await kb.configure(), 0);
		assert.match(log(), /-e DEBUG_INFO_NONE/);
		assert.ok(!/defconfig/.test(log().split('\n')[0]), 'copies the file instead of running a config target');
		assert.ok(fs.existsSync(path.join(s.buildDir(), '.config')));
		repo.remove();
	});

	it('builds with the recorded arguments and regenerates compile_commands.json', async () => {
		const { s, kb, log, repo } = fake();
		await kb.configure();
		mock.state.config['kernelDev.make.args'] = ['W=1']; // changed after Configure: not used
		assert.strictEqual(await kb.build(), 0);
		const builds = log().split('\n').filter(l => /^make /.test(l) && !/defconfig|olddefconfig/.test(l));
		assert.ok(builds.some(l => / compile_commands\.json$/.test(l)));
		assert.ok(builds.every(l => !/W=1/.test(l)), 'Build uses what Configure recorded');
		assert.ok(s.configured());
		repo.remove();
	});

	it('compiles one file, cleans, full-cleans and builds a directory', async () => {
		const { s, kb, log, root, repo } = fake();
		await kb.configure();
		repo.write('drivers/x/y.c', 'int y;\n');
		assert.strictEqual(await kb.compileFile(mock.vscode.Uri.file(path.join(root, 'drivers/x/y.c')), '.o'), 0);
		assert.match(log(), /make .* drivers\/x\/y\.o/);
		assert.strictEqual(await kb.compileFile(mock.vscode.Uri.file(path.join(root, 'Kbuild')), '.o'), 1, 'not a C file');
		assert.strictEqual(await kb.clean(), 0);
		assert.match(log(), /make .* clean/);
		assert.strictEqual(await kb.buildDirectory(mock.vscode.Uri.file(path.join(root, 'drivers/x'))), 0);
		assert.match(log(), /make .* drivers\/x\//);
		assert.strictEqual(await kb.mrproper(), 0);
		assert.match(log(), /make .* mrproper/);
		assert.strictEqual(s.configured(), undefined, 'Full clean forgets the configuration');
		repo.remove();
	});

	it('refuses to build when tools are missing', async () => {
		const { s, repo } = fake();
		const kb = new Kbuild(s);
		assert.strictEqual(kb.checkTools(['CROSS_COMPILE=no-such-prefix-'], 'arm64'), false);
		assert.match(mock.state.log.pop().message, /missing build: no-such-prefix-gcc/);
		repo.remove();
	});
});

describe('clangd', () => {
	it('publishes compile_commands.json, stripping gcc-only flags for GCC builds', async () => {
		const root = tempDir();
		const build = tempDir();
		const db = [{ directory: build, file: 'a.c', command: 'gcc -O2 -mrecord-mcount -fconserve-stack -Werror -Werror=implicit-int -c a.c' },
			{ directory: build, file: 'b.c', arguments: ['gcc', '-mskip-rax-setup', '-c', 'b.c'] }];
		fs.writeFileSync(path.join(build, 'compile_commands.json'), JSON.stringify(db));
		await updateCompileCommands(root, { arch: 'x86_64', buildDir: build, makeArgs: ['CROSS_COMPILE='] });
		const out = JSON.parse(fs.readFileSync(path.join(root, 'compile_commands.json'), 'utf8'));
		assert.strictEqual(out[0].command, 'gcc -O2 -Werror=implicit-int -c a.c -Wno-unknown-warning-option --target=x86_64-linux-gnu');
		assert.deepStrictEqual(out[1].arguments, ['gcc', '-c', 'b.c', '-Wno-unknown-warning-option', '--target=x86_64-linux-gnu']);
	});

	it('copies LLVM databases unchanged, and can be turned off', async () => {
		const root = tempDir();
		const build = tempDir();
		const db = [{ directory: build, file: 'a.c', command: 'clang -Werror -c a.c' }];
		fs.writeFileSync(path.join(build, 'compile_commands.json'), JSON.stringify(db));
		await updateCompileCommands(root, { arch: 'arm64', buildDir: build, makeArgs: ['LLVM=1'] });
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'compile_commands.json'), 'utf8')), db);
		fs.rmSync(path.join(root, 'compile_commands.json'));
		mock.state.config['kernelDev.clangd.updateCompileCommands'] = false;
		await updateCompileCommands(root, { arch: 'arm64', buildDir: build, makeArgs: ['LLVM=1'] });
		assert.ok(!fs.existsSync(path.join(root, 'compile_commands.json')));
	});
});

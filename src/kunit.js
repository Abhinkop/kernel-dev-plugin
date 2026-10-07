// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { archInfo, isNative } = require('./arch');
const { runTask, sq } = require('./tasks');

/** @typedef {import('./settings').Settings} Settings */

// kunit.py --arch names (tools/testing/kunit/qemu_configs/).
const KUNIT_ARCH = /** @type {Record<string, string>} */ ({ x86_64: 'x86_64', arm64: 'arm64', riscv64: 'riscv' });

/**
 * A KUnit group in kunit.py --json output: a suite, or a parameterized
 * test whose cases are its parameters.
 * @typedef {{ name: string, sub_groups?: Group[], test_cases?: { name: string, status: string }[] }} Group
 */

/**
 * Failure details from kunit.py's output: the lines it prints for a
 * failed test, and the first "EXPECTATION/ASSERTION FAILED at file:line".
 * @param {string} out
 * @returns {Map<string, { log: string, file?: string, line?: number }>} by test name
 */
function failures(out) {
	/** @type {Map<string, { log: string, file?: string, line?: number }>} */
	const map = new Map();
	/** @type {string[]} */
	let pending = [];
	for (const raw of out.split('\n')) {
		const line = raw.replace(/^\[\d\d:\d\d:\d\d\] /, '');
		const failed = /^\[FAILED\] (.+)$/.exec(line.trim());
		if (failed) {
			const log = pending.join('\n');
			const at = /(?:EXPECTATION|ASSERTION) FAILED at (\S+?):(\d+)/.exec(log);
			map.set(failed[1], { log, ...(at ? { file: at[1], line: +at[2] } : {}) });
			pending = [];
		} else if (/^\[(PASSED|SKIPPED)\] /.test(line.trim()) || /^=+/.test(line.trim())) {
			pending = [];
		} else {
			pending.push(line);
		}
	}
	return map;
}

class Kunit {
	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {Settings} s
	 */
	constructor(context, s) {
		this.context = context;
		this.s = s;
		this.root = s.root;
		this.controller = vscode.tests.createTestController('kernelDevKunit', 'KUnit');
		this.controller.createRunProfile('Run in QEMU', vscode.TestRunProfileKind.Run, (req, token) => this.run(req, token), true);
		this.controller.refreshHandler = () => this.load();
		context.subscriptions.push(this.controller);
		this.load();
	}

	get arch() {
		return this.s.arch;
	}

	buildDir() {
		const tmpl = this.s.get('kunit.buildDirectory', 'build/kunit/${arch}');
		return path.resolve(this.root, tmpl.replace(/\$\{arch\}/g, this.arch));
	}

	resultsFile() {
		return path.join(this.buildDir(), 'kernel-dev-results.json');
	}

	/** Test items from the last run's results (tests are known only after a run). */
	load() {
		const rootItem = this.controller.createTestItem('kunit', `KUnit (${this.arch})`);
		rootItem.description = 'run to discover the tests';
		this.controller.items.replace([rootItem]);
		let json;
		try {
			json = JSON.parse(fs.readFileSync(this.resultsFile(), 'utf8'));
		} catch {
			return;
		}
		rootItem.description = '';
		/** @param {vscode.TestItem} parent @param {Group} g @param {string} prefix */
		const add = (parent, g, prefix) => {
			const id = prefix ? `${prefix}.${g.name}` : g.name;
			const item = this.controller.createTestItem(id, g.name);
			parent.children.add(item);
			for (const sg of g.sub_groups || [])
				add(item, sg, id);
			for (const tc of g.test_cases || [])
				item.children.add(this.controller.createTestItem(`${id}.${tc.name}`, tc.name));
		};
		for (const g of /** @type {Group} */ (json).sub_groups || [])
			add(rootItem, g, '');
	}

	/**
	 * kunit.py run for the selected architecture and toolchain.
	 * @param {string | undefined} filter --filter_glob
	 * @param {string | undefined} kunitconfig
	 * @param {string} log where the output goes
	 */
	command(filter, kunitconfig, log) {
		const args = ['python3', 'tools/testing/kunit/kunit.py', 'run', `--arch=${KUNIT_ARCH[this.arch]}`,
			`--build_dir=${this.buildDir()}`, `--jobs=${this.s.jobs().slice(2)}`, `--json=${this.resultsFile()}.new`];
		if (this.s.get('toolchain', 'gcc') === 'llvm')
			args.push('--make_options=LLVM=1');
		else if (!isNative(this.arch)) {
			const prefixes = this.s.get('crossCompile', /** @type {Record<string,string>} */ ({}));
			args.push(`--cross_compile=${prefixes[this.arch] ?? archInfo(this.arch).gccPrefix}`);
		}
		const config = kunitconfig || this.s.get('kunit.kunitconfig', '');
		if (config)
			args.push(`--kunitconfig=${config}`);
		if (filter)
			args.push(filter);
		return `set -o pipefail; ${args.map(sq).join(' ')} 2>&1 | tee ${sq(log)}`;
	}

	/**
	 * @param {vscode.TestRunRequest} req
	 * @param {vscode.CancellationToken} token
	 * @param {string} [kunitconfig]
	 */
	async run(req, token, kunitconfig) {
		const run = this.controller.createTestRun(req);
		// One filter glob: a single suite or test when exactly one is
		// requested, otherwise everything (results are then reported for
		// the requested items only).
		const include = req.include || [];
		const one = include.length === 1 && include[0].id !== 'kunit' ? include[0].id : undefined;
		const filter = one ? (one.split('.').length === 1 ? one : one.split('.').slice(0, 2).join('.')) : undefined;
		fs.mkdirSync(this.buildDir(), { recursive: true });
		const log = path.join(this.buildDir(), 'kernel-dev-output.log');
		const code = await runTask(this.s.folder, `KUnit ${this.arch}${filter ? ` ${filter}` : ''}`, 'bash',
			['-c', this.command(filter, kunitconfig, log)], { step: 'kunit' });
		let out = '';
		try {
			out = fs.readFileSync(log, 'utf8');
		} catch {}
		const fresh = `${this.resultsFile()}.new`;
		if (!fs.existsSync(fresh)) {
			run.appendOutput(out.replace(/\n/g, '\r\n'));
			for (const t of include.length ? include : [...this.all()])
				run.errored(t, new vscode.TestMessage(`kunit.py did not produce results (exit ${code}); see the KUnit terminal.`));
			run.end();
			return;
		}
		// Merge into the known results so a filtered run keeps the others.
		const results = /** @type {Group} */ (JSON.parse(fs.readFileSync(fresh, 'utf8')));
		fs.rmSync(fresh, { force: true });
		if (!filter || !fs.existsSync(this.resultsFile()))
			fs.writeFileSync(this.resultsFile(), JSON.stringify(results));
		else {
			const known = /** @type {Group} */ (JSON.parse(fs.readFileSync(this.resultsFile(), 'utf8')));
			for (const g of results.sub_groups || []) {
				const i = (known.sub_groups || []).findIndex(k => k.name === g.name);
				if (i >= 0) known.sub_groups?.splice(i, 1, g); else (known.sub_groups ||= []).push(g);
			}
			fs.writeFileSync(this.resultsFile(), JSON.stringify(known));
		}
		this.load();
		const why = failures(out);
		/** @param {Group} g @param {string} prefix */
		const report = (g, prefix) => {
			const id = prefix ? `${prefix}.${g.name}` : g.name;
			for (const sg of g.sub_groups || [])
				report(sg, id);
			for (const tc of g.test_cases || []) {
				const item = this.find(`${id}.${tc.name}`);
				if (!item || !wanted(item))
					continue;
				if (tc.status === 'PASS')
					run.passed(item);
				else if (tc.status === 'SKIP')
					run.skipped(item);
				else {
					const f = why.get(tc.name);
					const msg = new vscode.TestMessage(f?.log.trim() || `${tc.status}`);
					if (f?.file && f.line)
						msg.location = new vscode.Location(vscode.Uri.file(path.join(this.root, f.file)), new vscode.Range(f.line - 1, 0, f.line - 1, 0));
					run.failed(item, msg);
				}
			}
		};
		const wanted = (/** @type {vscode.TestItem} */ item) => !include.length || include.some(i => i.id === 'kunit' || item.id === i.id || item.id.startsWith(`${i.id}.`));
		for (const g of results.sub_groups || [])
			report(g, '');
		run.end();
	}

	/** @param {string} id */
	find(id) {
		for (const t of this.all())
			if (t.id === id)
				return t;
		return undefined;
	}

	*all() {
		/** @type {vscode.TestItem[]} */
		const stack = [];
		this.controller.items.forEach(i => stack.push(i));
		while (stack.length) {
			const t = /** @type {vscode.TestItem} */ (stack.pop());
			yield t;
			t.children.forEach(c => stack.push(c));
		}
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {Settings} s
 */
function registerKunit(context, s) {
	const kunit = new Kunit(context, s);
	s.onDidChange(() => kunit.load());
	context.subscriptions.push(
		vscode.commands.registerCommand('kernelDev.kunit.runDirectory', async (/** @type {vscode.Uri | undefined} */ uri) => {
			const target = uri || vscode.window.activeTextEditor?.document.uri;
			if (!target)
				return;
			let dir = fs.existsSync(target.fsPath) && fs.statSync(target.fsPath).isDirectory() ? target.fsPath : path.dirname(target.fsPath);
			// The nearest .kunitconfig up the tree.
			while (dir.startsWith(s.root) && !fs.existsSync(path.join(dir, '.kunitconfig')))
				dir = path.dirname(dir);
			if (!fs.existsSync(path.join(dir, '.kunitconfig')))
				return vscode.window.showWarningMessage('Kernel: no .kunitconfig in this directory or above it.');
			const req = new vscode.TestRunRequest();
			await kunit.run(req, new vscode.CancellationTokenSource().token, path.relative(s.root, dir));
		}),
	);
	return kunit;
}

module.exports = { Kunit, registerKunit, failures, KUNIT_ARCH };

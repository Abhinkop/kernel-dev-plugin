// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { git } = require('./git');
const { archInfo } = require('./arch');
const { runTask, sq } = require('./tasks');
const { onPath } = require('./tools');

/** @typedef {import('./settings').Settings} Settings */
/** @typedef {import('./settings').Configured} Configured */

const BINDINGS = 'Documentation/devicetree/bindings/';

/**
 * What to check for a set of changed files: the .dtb of every changed
 * .dts, of every .dts that includes a changed .dtsi from its directory,
 * and the changed binding schemas.
 * @param {string} root
 * @param {string} karch kbuild ARCH
 * @param {string[]} files repository-relative
 */
function targets(root, karch, files) {
	const dtsDir = `arch/${karch}/boot/dts/`;
	const dtbs = new Set();
	for (const f of files.filter(f => f.startsWith(dtsDir))) {
		if (f.endsWith('.dts')) {
			dtbs.add(f.slice(dtsDir.length).replace(/\.dts$/, '.dtb'));
		} else if (f.endsWith('.dtsi')) {
			const dir = path.join(root, path.dirname(f));
			const name = path.basename(f);
			/** @type {string[]} */
			let entries = [];
			try {
				entries = fs.readdirSync(dir).filter(e => e.endsWith('.dts'));
			} catch {}
			for (const e of entries)
				if (fs.readFileSync(path.join(dir, e), 'utf8').includes(name))
					dtbs.add(path.join(path.dirname(f), e).slice(dtsDir.length).replace(/\.dts$/, '.dtb'));
		}
	}
	const schemas = files.filter(f => f.startsWith(BINDINGS) && f.endsWith('.yaml')).map(f => f.slice(BINDINGS.length));
	return { dtbs: [...dtbs].sort(), schemas };
}

/**
 * Parse dtc and dt-schema output into findings.
 * dtc:    arch/arm64/boot/dts/x/board.dts:12.5-20: Warning (unit_address_vs_reg): /soc/foo: ...
 * schema: arch/arm64/boot/dts/x/board.dtb: serial@1000 (vendor,uart): compatible: ... is not valid ...
 * yaml:   Documentation/devicetree/bindings/x.yaml:12:3: [error] ...
 * @param {string} out
 * @param {string} root
 * @param {string} buildDir
 */
function parse(out, root, buildDir) {
	/** @type {{ file: string, line: number, severity: 'error'|'warning', message: string }[]} */
	const findings = [];
	const rel = (/** @type {string} */ f) => {
		const abs = path.isAbsolute(f) ? f : path.join(root, f);
		return path.relative(root, abs.startsWith(buildDir) ? path.join(root, path.relative(buildDir, abs)) : abs);
	};
	for (const line of out.split('\n')) {
		let m = /^(\S+\.dtsi?):(\d+)\.\d+-[\d.]+: (Warning|Error) \(([\w-]+)\): (.*)$/.exec(line);
		if (m) {
			findings.push({ file: rel(m[1]), line: +m[2], severity: m[3] === 'Error' ? 'error' : 'warning', message: `${m[4]}: ${m[5]}` });
			continue;
		}
		// dtc syntax errors: "Error: /abs/board.dts:20.2-44 Properties must precede subnodes"
		m = /^(Error|Warning): (\S+\.dtsi?):(\d+)\.[\d.-]+ (.*)$/.exec(line);
		if (m) {
			findings.push({ file: rel(m[2]), line: +m[3], severity: m[1] === 'Error' ? 'error' : 'warning', message: m[4] });
			continue;
		}
		m = /^(\S+\.yaml):(\d+):\d+: \[(error|warning)\] (.*)$/.exec(line);
		const y = m;
		if (y && findings.some(f => f.file === rel(y[1]) && f.line === +y[2] && f.message === y[4]))
			continue; // yamllint run directly and again by dt_binding_check
		if (m) {
			findings.push({ file: rel(m[1]), line: +m[2], severity: m[3] === 'error' ? 'error' : 'warning', message: m[4] });
			continue;
		}
		m = /^(\S+)\.dtb: (.*)$/.exec(line);
		if (m && !/^\s/.test(m[2])) {
			// Schema errors name the .dtb; point at the node in the .dts.
			const dts = rel(`${m[1]}.dts`);
			findings.push({ file: dts, line: nodeLine(path.join(root, dts), m[2]), severity: 'warning', message: m[2] });
		}
	}
	return findings;
}

/**
 * Line of the node a schema message is about ("serial@1000 (...): ..."
 * or "/soc/serial@1000: ..."), or 1.
 * @param {string} file @param {string} message
 */
function nodeLine(file, message) {
	if (!fs.existsSync(file))
		return 1;
	// Candidates: the last element of a leading node path ("/soc/serial@1000:"),
	// then any node with a unit address the message mentions ("bogus@1000").
	const names = [];
	const p = /^\/((?:[\w,@.+-]+\/)*[\w,@.+-]+):/.exec(message);
	if (p)
		names.push(p[1].split('/').pop() || '');
	for (const m of message.matchAll(/([A-Za-z][\w,.+-]*@[0-9a-fA-F,]+)/g))
		names.push(m[1]);
	const lines = fs.readFileSync(file, 'utf8').split('\n');
	for (const node of names.filter(Boolean)) {
		const re = new RegExp(`(^|[\\s:&])${node.replace(/[.+]/g, '\\$&')}\\s*\\{`);
		const i = lines.findIndex(l => re.test(l));
		if (i >= 0)
			return i + 1;
	}
	return 1;
}

class DtChecks {
	/** @param {Settings} s */
	constructor(s) {
		this.s = s;
		this.root = s.root;
		this.diagnostics = vscode.languages.createDiagnosticCollection('devicetree');
	}

	/**
	 * @param {string[]} files changed files; empty for a full dtbs_check
	 * @returns {Promise<string>} a one-line summary
	 */
	async check(files) {
		const state = this.s.configured();
		if (!state)
			return 'skipped: configure a build in the Kernel tab';
		const karch = archInfo(state.arch).kernelArch;
		if (!['arm64', 'riscv'].includes(karch))
			return `skipped: ${state.arch} kernels do not use devicetree`;
		if (!onPath('dt-validate'))
			return 'skipped: dt-schema is not installed (pip install dtschema; also yamllint)';
		const full = !files.length;
		const t = targets(this.root, karch, files);
		if (!full && !t.dtbs.length && !t.schemas.length)
			return 'no devicetree files changed';
		const make = (/** @type {string[]} */ ...a) => ['make', ...state.makeArgs, this.s.jobs(), ...a].map(sq).join(' ');
		const steps = full ? [make('dtbs_check')] : [
			// An up-to-date .dtb is not checked again; remove the targets
			// (build output) so they are rebuilt and validated.
			...(t.dtbs.length ? [`rm -f ${t.dtbs.map(d => sq(path.join(state.buildDir, 'arch', karch, 'boot', 'dts', d))).join(' ')}`,
				make('CHECK_DTBS=y', ...t.dtbs)] : []),
			// make skips dt_binding_check when nothing changed; lint the
			// changed schemas every time, the way it would.
			...(t.schemas.length ? [`yamllint -f parsable -c ${BINDINGS}.yamllint ${t.schemas.map(y => sq(BINDINGS + y)).join(' ')}`] : []),
			...t.schemas.map(y => make('dt_binding_check', `DT_SCHEMA_FILES=${y}`)),
		];
		const log = path.join(os.tmpdir(), `kernel-dev-dt-${process.pid}.log`);
		const what = full ? 'all dtbs' : [t.dtbs.length && `${t.dtbs.length} dtb`, t.schemas.length && `${t.schemas.length} binding`].filter(Boolean).join(', ');
		const code = await runTask(this.s.folder, `DT check (${what})`, 'bash',
			['-c', `set -o pipefail; { rc=0; ${steps.map(c => `${c} || rc=1`).join('; ')}; exit $rc; } 2>&1 | tee ${sq(log)}`], { step: 'dt' });
		let out = '';
		try {
			out = fs.readFileSync(log, 'utf8');
			fs.rmSync(log, { force: true });
		} catch {}
		const findings = parse(out, this.root, state.buildDir);
		/** @type {Map<string, vscode.Diagnostic[]>} */
		const byFile = new Map();
		for (const f of findings) {
			const d = new vscode.Diagnostic(new vscode.Range(f.line - 1, 0, f.line - 1, 1000), f.message,
				f.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
			d.source = 'devicetree';
			byFile.set(f.file, [...(byFile.get(f.file) || []), d]);
		}
		this.diagnostics.clear();
		for (const [file, list] of byFile)
			this.diagnostics.set(vscode.Uri.file(path.join(this.root, file)), list);
		return `DT check (${what}): ${findings.length ? `${findings.length} findings (see Problems)` : code === 0 ? 'clean' : 'failed (see the terminal)'}`;
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {Settings} s
 */
function registerDt(context, s) {
	const dt = new DtChecks(s);
	/** @param {string} summary */
	const report = summary => vscode.window.showInformationMessage(`Kernel: ${summary}`);
	context.subscriptions.push(
		dt.diagnostics,
		vscode.commands.registerCommand('kernelDev.dt.checkChanged', async () => {
			const files = (await git(s.root, ['diff', '--name-only', '--diff-filter=d', 'HEAD'])).split('\n').filter(Boolean);
			report(files.length ? await dt.check(files) : 'no uncommitted changes; use "DT Check: All dtbs" for everything');
		}),
		vscode.commands.registerCommand('kernelDev.dt.checkAll', async () => report(await dt.check([]))),
	);
	return dt;
}

module.exports = { DtChecks, registerDt, targets, parse, nodeLine };

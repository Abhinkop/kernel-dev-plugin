// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** @typedef {import('./settings').Configured} Configured */

const SCHEME = 'kernel-oops';

// First line of a kernel crash report.
const START = /\b(Oops|BUG:|WARNING:|Kernel panic - not syncing|general protection fault|Unable to handle kernel|kernel BUG at|Internal error:|BUG kernel NULL pointer)/;
// Last line of one.
const END = /---\[ end (trace|Kernel panic)/;

/**
 * Decode a crash report with the tree's scripts/decode_stacktrace.sh
 * against the build's vmlinux; the tools follow the build's LLVM= /
 * CROSS_COMPILE=.
 * @param {string} root
 * @param {Configured} state
 * @param {string} text
 * @returns {Promise<string>}
 */
function decode(root, state, text) {
	/** @type {Record<string, string>} */
	const env = {};
	for (const a of state.makeArgs) {
		const m = /^(LLVM|CROSS_COMPILE)=(.*)$/.exec(a);
		if (m && m[2])
			env[m[1]] = m[2];
	}
	return new Promise((resolve, reject) => {
		const child = execFile('bash', [path.join(root, 'scripts', 'decode_stacktrace.sh'), path.join(state.buildDir, 'vmlinux'), root], {
			cwd: root, maxBuffer: 16 << 20, env: { ...process.env, ...env },
		}, (err, stdout, stderr) => err && !stdout ? reject(new Error(stderr || err.message)) : resolve(stdout));
		child.stdin?.end(text);
	});
}

/**
 * Frames with a source location in decoded output, which looks like
 *   [    7.769682]  sysrq_handle_crash (drivers/tty/sysrq.c:154)
 *   [    7.768643]  dump_stack_lvl (lib/dump_stack.c:94 lib/dump_stack.c:120)
 * where an inlined call lists the innermost location first. Frames the
 * kernel marks with "?" are unreliable leftovers on the stack.
 * @param {string} decoded
 * @returns {{ func: string, file: string, line: number, reliable: boolean, text: string }[]}
 */
function frames(decoded) {
	const out = [];
	for (const text of decoded.split('\n')) {
		const m = /^(?:\[[\s\d.]*\])?\s*(\? )?([\w.]+)(?:\+0x[0-9a-f]+\/0x[0-9a-f]+)? (?:\[[\w-]+\] )?\((\S+\.[chS]):(\d+)/.exec(text);
		if (m)
			out.push({ func: m[2], file: m[3], line: +m[4], reliable: !m[1], text: text.trim() });
	}
	return out;
}

/**
 * Watches the VM's console log, and decodes and reports crashes.
 */
class OopsWatcher {
	/** @param {string} root */
	constructor(root) {
		this.root = root;
		/** @type {Map<string, string>} decoded reports by document id */
		this.reports = new Map();
		this.count = 0;
		this.diagnostics = vscode.languages.createDiagnosticCollection('kernel oops');
		/** @type {NodeJS.Timeout | undefined} */
		this.timer = undefined;
	}

	/**
	 * Follow a console log from the start (the VM truncates it at boot).
	 * @param {string} file
	 * @param {Configured} state
	 */
	watch(file, state) {
		this.stop();
		let offset = 0, partial = '';
		/** @type {string[] | undefined} */
		let report;
		let quietTicks = 0;
		const flush = () => {
			const lines = report;
			report = undefined;
			if (lines)
				this.found(lines.join('\n'), state);
		};
		this.timer = setInterval(() => {
			let size;
			try {
				size = fs.statSync(file).size;
			} catch {
				return;
			}
			if (size < offset)
				offset = 0; // a new boot truncated it
			if (size === offset) {
				if (report && ++quietTicks >= 4) // 2s without more output ends a report
					flush();
				return;
			}
			quietTicks = 0;
			const fd = fs.openSync(file, 'r');
			const buf = Buffer.alloc(size - offset);
			fs.readSync(fd, buf, 0, buf.length, offset);
			fs.closeSync(fd);
			offset = size;
			const lines = (partial + buf.toString('utf8').replace(/\r/g, '')).split('\n');
			partial = lines.pop() || '';
			for (const line of lines) {
				if (!report && START.test(line))
					report = [];
				if (!report)
					continue;
				report.push(line);
				if (END.test(line) || report.length >= 400)
					flush();
			}
		}, 500);
	}

	stop() {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * @param {string} text
	 * @param {Configured} state
	 */
	async found(text, state) {
		const title = text.split('\n').find(l => START.test(l))?.replace(/^\[[\s\d.]+\]\s*/, '').trim() || 'kernel crash';
		const pick = await vscode.window.showErrorMessage(`Kernel: the VM reported "${title}".`, 'Show Decoded Trace');
		if (pick)
			await this.show(text, state, title);
	}

	/**
	 * Decode and open a report; frames also go to Problems.
	 * @param {string} text
	 * @param {Configured} state
	 * @param {string} [title]
	 */
	async show(text, state, title = 'stack trace') {
		let decoded;
		try {
			decoded = await decode(this.root, state, text);
		} catch (e) {
			decoded = `${text}\n\n(decode_stacktrace.sh failed: ${/** @type {Error} */ (e).message})`;
		}
		const fr = frames(decoded);
		/** @type {Map<string, vscode.Diagnostic[]>} */
		const byFile = new Map();
		fr.filter(f => f.reliable).forEach((f, i) => {
			const d = new vscode.Diagnostic(new vscode.Range(f.line - 1, 0, f.line - 1, 1000),
				`${title}: frame ${i}: ${f.func}`, i === 0 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information);
			d.source = 'oops';
			const abs = path.resolve(this.root, f.file);
			byFile.set(abs, [...(byFile.get(abs) || []), d]);
		});
		this.diagnostics.clear();
		for (const [file, list] of byFile)
			this.diagnostics.set(vscode.Uri.file(file), list);

		const id = String(++this.count);
		this.reports.set(id, `${title}\nvmlinux: ${path.join(state.buildDir, 'vmlinux')}\n${fr.length} frames with source locations (also in Problems)\n\n${decoded}`);
		const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/${title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60)}.oops` });
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
		return { decoded, frames: fr };
	}

	/** @type {vscode.TextDocumentContentProvider['provideTextDocumentContent']} */
	provideTextDocumentContent(uri) {
		return this.reports.get(uri.path.split('/')[1]) || '';
	}

	/**
	 * Every "path/file.c:123" in a decoded report becomes a link.
	 * @param {vscode.TextDocument} doc
	 * @returns {vscode.DocumentLink[]}
	 */
	provideDocumentLinks(doc) {
		const links = [];
		for (let i = 0; i < doc.lineCount; i++) {
			const text = doc.lineAt(i).text;
			for (const m of text.matchAll(/(?<![\w/.-])([\w./-]+\.[chS]):(\d+)/g)) {
				const abs = path.resolve(this.root, m[1]);
				if (!fs.existsSync(abs))
					continue;
				const target = vscode.Uri.file(abs).with({ fragment: `L${m[2]}` });
				links.push(new vscode.DocumentLink(new vscode.Range(i, m.index || 0, i, (m.index || 0) + m[0].length), target));
			}
		}
		return links;
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./settings').Settings} s
 */
function registerOops(context, s) {
	const watcher = new OopsWatcher(s.root);
	context.subscriptions.push(
		watcher.diagnostics,
		{ dispose: () => watcher.stop() },
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, watcher),
		vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, watcher),
		vscode.commands.registerCommand('kernelDev.oops.decode', async () => {
			const state = s.configured();
			if (!state)
				return vscode.window.showErrorMessage('Kernel: decoding needs a configured and built kernel (Kernel tab).');
			const editor = vscode.window.activeTextEditor;
			const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
			const text = selected || await vscode.env.clipboard.readText();
			if (!text.trim())
				return vscode.window.showWarningMessage('Kernel: select a stack trace, or copy one to the clipboard, then run this again.');
			await watcher.show(text, state);
		}),
	);
	return watcher;
}

module.exports = { OopsWatcher, registerOops, decode, frames, START, END };

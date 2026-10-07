// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { git, gitStatus, exists, fixesLine } = require('./git');
const { openCommit } = require('./commits');
const { runTask, sq } = require('./tasks');
const { page } = require('./webview');

/** @typedef {import('./settings').Settings} Settings */

/**
 * git bisect, driven from the Kernel Git tab. The state lives in git
 * (.git/BISECT_LOG), so a bisect started on the command line shows up
 * here too and vice versa.
 */
class Bisect {
	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {Settings} s
	 */
	constructor(context, s) {
		this.context = context;
		this.s = s;
		this.root = s.root;
		this.active = false;
		/** @type {{ hash: string, subject: string } | undefined} */
		this.current = undefined;
		this.remaining = '';
		/** @type {{ hash: string, subject: string } | undefined} */
		this.result = undefined;
		/** @type {string[]} */
		this.log = [];
		this.message = '';
		this.busy = '';
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChange = this._onDidChange.event;
	}

	changed() {
		this._onDidChange.fire(undefined);
	}

	async refresh() {
		this.active = fs.existsSync(path.join(this.root, '.git', 'BISECT_LOG'));
		this.log = [];
		this.current = undefined;
		if (this.active) {
			const log = (await gitStatus(this.root, ['bisect', 'log'])).stdout;
			this.log = log.split('\n').filter(l => /^# (good|bad|skip|first bad commit)/.test(l)).map(l => l.slice(2));
			const head = (await git(this.root, ['log', '-1', '--format=%H%x00%s'])).trim().split('\0');
			this.current = { hash: head[0], subject: head[1] };
			const first = /^# first bad commit: \[([0-9a-f]+)\] (.*)$/m.exec(log);
			if (first)
				this.result = { hash: first[1], subject: first[2] };
		}
		this.changed();
	}

	/**
	 * @param {string} bad
	 * @param {string} good
	 */
	async start(bad, good) {
		for (const rev of [bad, good])
			if (!await exists(this.root, rev))
				return vscode.window.showErrorMessage(`Kernel: "${rev}" is not a commit here.`);
		this.result = undefined;
		await this.step(['start', bad, good]);
	}

	/**
	 * Run a git bisect subcommand and digest its answer.
	 * @param {string[]} args
	 */
	async step(args) {
		this.busy = `git bisect ${args[0]}`;
		this.changed();
		const r = await gitStatus(this.root, ['bisect', ...args]);
		this.busy = '';
		const out = `${r.stdout}\n${r.stderr}`;
		const left = /Bisecting: (.*)$/m.exec(out);
		this.remaining = left ? left[1] : '';
		const first = /^([0-9a-f]{40}) is the first bad commit/m.exec(out);
		if (first) {
			const subject = (await git(this.root, ['log', '-1', '--format=%s', first[1]])).trim();
			this.result = { hash: first[1], subject };
			this.message = `First bad commit: ${first[1].slice(0, 12)} ${subject}`;
			await openCommit(this.root, first[1]);
		} else if (r.code !== 0) {
			this.message = out.trim().split('\n').slice(-3).join(' ');
		} else {
			this.message = '';
		}
		await this.refresh();
	}

	async reset() {
		await this.step(['reset']);
		this.remaining = '';
		this.message = 'Bisect reset: back on the branch you started from.';
		this.changed();
	}

	/**
	 * git bisect run with a wrapper: build the selected kernel (a build
	 * failure tells git to skip the commit, exit 125), then run the
	 * user's test script with the build directory as its argument; its
	 * exit code says good (0) or bad (1-127 except 125).
	 * @param {string} script
	 */
	async run(script) {
		const state = this.s.configured();
		if (!state)
			return vscode.window.showErrorMessage('Kernel: configure a build in the Kernel tab first; each bisect step builds it.');
		const abs = path.resolve(this.root, script);
		if (!fs.existsSync(abs))
			return vscode.window.showErrorMessage(`Kernel: test script ${abs} does not exist.`);
		const dir = (this.context.storageUri || this.context.globalStorageUri).fsPath;
		fs.mkdirSync(dir, { recursive: true });
		const wrapper = path.join(dir, 'bisect-step.sh');
		fs.writeFileSync(wrapper, [
			'#!/bin/sh',
			'# Written by the Kernel Dev extension for git bisect run.',
			`make ${state.makeArgs.map(sq).join(' ')} ${this.s.jobs()} >/dev/null 2>&1 || { echo "bisect: build failed at $(git log -1 --format=%h), skipping"; exit 125; }`,
			`exec ${sq(abs)} ${sq(state.buildDir)}`,
			'',
		].join('\n'), { mode: 0o755 });
		this.busy = 'git bisect run';
		this.changed();
		const code = await runTask(this.s.folder, 'git bisect run', 'git',
			['bisect', 'run', wrapper], { step: 'bisect' });
		this.busy = '';
		await this.refresh();
		const log = (await gitStatus(this.root, ['bisect', 'log'])).stdout;
		const first = /^# first bad commit: \[([0-9a-f]+)\] (.*)$/m.exec(log);
		this.message = first ? `First bad commit: ${first[1].slice(0, 12)} ${first[2]}` : `git bisect run ended (exit ${code}); see the terminal.`;
		if (first)
			await openCommit(this.root, first[1]);
		this.changed();
	}
}

/**
 * The Bisect view in the Kernel Git tab.
 * @implements {vscode.WebviewViewProvider}
 */
class BisectView {
	/** @param {Bisect} bisect */
	constructor(bisect) {
		this.bisect = bisect;
		/** @type {vscode.WebviewView | undefined} */
		this.view = undefined;
		bisect.onDidChange(() => this.push());
	}

	/** @param {vscode.WebviewView} view */
	resolveWebviewView(view) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = html();
		view.webview.onDidReceiveMessage(m => this.onMessage(m));
		view.onDidChangeVisibility(() => view.visible && this.bisect.refresh());
		this.bisect.refresh();
	}

	/** @param {any} m */
	async onMessage(m) {
		const b = this.bisect;
		if (m.type === 'ready')
			return this.push();
		if (m.type === 'start')
			return b.start(m.bad.trim() || 'HEAD', m.good.trim());
		if (m.type === 'run')
			return b.run(m.script.trim());
		if (m.type !== 'command')
			return;
		switch (m.command) {
		case 'good': case 'bad': case 'skip': return b.step([m.command]);
		case 'reset': return b.reset();
		case 'build': return vscode.commands.executeCommand('kernelDev.build');
		case 'boot': return vscode.commands.executeCommand('kernelDev.run');
		case 'openCurrent': return b.current && openCommit(b.root, b.current.hash);
		case 'openResult': return b.result && openCommit(b.root, b.result.hash);
		case 'copyFixes': {
			if (!b.result)
				return;
			const line = await fixesLine(b.root, b.result.hash);
			await vscode.env.clipboard.writeText(line);
			return vscode.window.showInformationMessage(`Copied: ${line}`);
		}
		}
	}

	push() {
		if (!this.view?.visible)
			return;
		const b = this.bisect;
		this.view.webview.postMessage({
			type: 'state', active: b.active, current: b.current, remaining: b.remaining,
			result: b.result, log: b.log, message: b.message, busy: b.busy,
		});
	}
}

function html() {
	return page(`
	<div id="startBox">
		<h3>Start</h3>
		<label for="bad">Bad (has the bug)</label>
		<input id="bad" placeholder="HEAD">
		<label for="good">Good (works)</label>
		<input id="good" placeholder="e.g. v6.12 or a commit">
		<div class="steps" style="grid-template-columns: 1fr"><button id="start">Start bisect</button></div>
	</div>

	<div id="stepBox">
		<h3>Current step</h3>
		<p><a data-cmd="openCurrent" id="current"></a></p>
		<p id="remaining" class="hint"></p>
		<div class="steps">
			<button data-cmd="build" class="secondary">🔨 Build</button>
			<button data-cmd="boot" class="secondary">▶ Boot</button>
		</div>
		<div class="steps" style="grid-template-columns: 1fr 1fr 1fr">
			<button data-cmd="good">Good</button>
			<button data-cmd="bad">Bad</button>
			<button data-cmd="skip" class="secondary">Skip</button>
		</div>
		<h3>Automatic</h3>
		<label for="script">Test script (gets the build directory; exit 0 = good, 1 = bad, 125 = skip)</label>
		<div class="row"><input id="script" placeholder="path/to/test.sh"><button class="fit secondary" id="run">Run</button></div>
		<p class="hint">Each step builds the kernel selected in the Kernel tab first; a build failure skips the commit.</p>
		<h3>Log</h3>
		<ul id="log" class="list"></ul>
		<div class="tools"><button class="secondary" data-cmd="reset">Reset (end bisect)</button></div>
	</div>

	<div id="resultBox">
		<h3>Result</h3>
		<p>First bad commit: <a data-cmd="openResult" id="result"></a></p>
		<div class="tools"><button class="secondary" data-cmd="copyFixes">Copy Fixes: line</button></div>
	</div>
	<p id="busy" class="busy"></p>
	<p id="message"></p>
`, `
	$('start').addEventListener('click', () => vscode.postMessage({ type: 'start', bad: $('bad').value, good: $('good').value }));
	$('run').addEventListener('click', () => vscode.postMessage({ type: 'run', script: $('script').value }));
	window.addEventListener('message', ({ data: st }) => {
		if (st.type !== 'state') return;
		$('startBox').style.display = st.active ? 'none' : '';
		$('stepBox').style.display = st.active ? '' : 'none';
		$('resultBox').style.display = st.result ? '' : 'none';
		if (st.current) $('current').textContent = st.current.hash.slice(0, 12) + ' ' + st.current.subject;
		$('remaining').textContent = st.remaining;
		$('log').innerHTML = st.log.map(l => '<li><span class="grow">' + esc(l) + '</span></li>').join('');
		if (st.result) $('result').textContent = st.result.hash.slice(0, 12) + ' ' + st.result.subject;
		$('busy').textContent = st.busy ? st.busy + '…' : '';
		$('message').textContent = st.message;
		document.querySelectorAll('button').forEach(b => b.disabled = !!st.busy);
	});
	vscode.postMessage({ type: 'ready' });
`);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {Settings} s
 */
function registerBisect(context, s) {
	const bisect = new Bisect(context, s);
	const view = new BisectView(bisect);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('kernelDev.bisect', view, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('kernelDev.bisect.good', () => bisect.step(['good'])),
		vscode.commands.registerCommand('kernelDev.bisect.bad', () => bisect.step(['bad'])),
		vscode.commands.registerCommand('kernelDev.bisect.skip', () => bisect.step(['skip'])),
		vscode.commands.registerCommand('kernelDev.bisect.reset', () => bisect.reset()),
	);
	return { bisect, view };
}

module.exports = { Bisect, BisectView, registerBisect, html };

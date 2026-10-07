// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { git, gitStatus, exists, fixesLine } = require('./git');
const { openCommit } = require('./commits');
const { runTask, sq } = require('./tasks');

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
			`make ${this.s.makeArgs(state).map(sq).join(' ')} ${this.s.jobs()} >/dev/null 2>&1 || { echo "bisect: build failed at $(git log -1 --format=%h), skipping"; exit 125; }`,
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

class Item extends vscode.TreeItem {
	/**
	 * @param {string} label
	 * @param {{ description?: string, icon?: string, color?: string, tooltip?: string, contextValue?: string,
	 *           children?: Item[], command?: vscode.Command }} [o]
	 */
	constructor(label, o = {}) {
		super(label, o.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		this.description = o.description;
		if (o.icon)
			this.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
		this.tooltip = o.tooltip;
		this.contextValue = o.contextValue;
		this.children = o.children;
		if (o.command)
			this.command = o.command;
	}
}

/**
 * The Bisect view in the Kernel Git tab.
 * @implements {vscode.TreeDataProvider<Item>}
 */
class BisectTree {
	/** @param {Bisect} bisect */
	constructor(bisect) {
		this.bisect = bisect;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		bisect.onDidChange(() => this.refresh());
	}

	refresh() {
		const b = this.bisect;
		vscode.commands.executeCommand('setContext', 'kernelDev.bisectActive', b.active);
		vscode.commands.executeCommand('setContext', 'kernelDev.bisectIdle', !b.active && !b.result && !b.busy && !b.message);
		this._onDidChangeTreeData.fire(undefined);
	}

	/** @param {Item} item */
	getTreeItem(item) {
		return item;
	}

	/** @param {Item} [item] */
	getChildren(item) {
		if (item)
			return item.children || [];
		const b = this.bisect;
		/** @type {Item[]} */
		const items = [];
		if (b.busy)
			items.push(new Item(b.busy, { icon: 'loading~spin' }));
		const act = (/** @type {string} */ label, /** @type {string} */ command, /** @type {string} */ icon, /** @type {string} */ description) =>
			new Item(label, { icon, description, tooltip: `Click to ${label.toLowerCase()}`, command: { command, title: label } });
		if (b.active)
			items.push(new Item('Actions', { icon: 'play-circle', children: [
				act('Build', 'kernelDev.build', 'tools', 'build the commit under test'),
				act('Run', 'kernelDev.run', 'play', 'boot it in QEMU'),
				act('Mark good', 'kernelDev.bisect.good', 'pass', 'git bisect good'),
				act('Mark bad', 'kernelDev.bisect.bad', 'error', 'git bisect bad'),
				act('Skip', 'kernelDev.bisect.skip', 'debug-step-over', 'git bisect skip'),
				act('Reset', 'kernelDev.bisect.reset', 'discard', 'git bisect reset'),
			] }));
		else if (b.result)
			items.push(new Item('Actions', { icon: 'play-circle', children: [
				act('Start another bisect…', 'kernelDev.bisect.start', 'debug-start', 'git bisect start'),
			] }));
		if (b.result)
			items.push(new Item(b.result.subject, {
				description: `first bad commit · ${b.result.hash.slice(0, 12)}`, icon: 'bug', color: 'problemsErrorIcon.foreground',
				contextValue: 'result', tooltip: b.result.hash,
				command: { command: 'kernelDev.git.openCommit', title: 'Open Commit', arguments: [b.result.hash] },
			}));
		if (b.active && b.current)
			items.push(new Item(b.current.subject, {
				description: `testing · ${b.current.hash.slice(0, 12)}`, icon: 'debug-breakpoint-unverified',
				tooltip: b.remaining || b.current.hash,
				command: { command: 'kernelDev.git.openCommit', title: 'Open Commit', arguments: [b.current.hash] },
			}));
		if (b.active && b.remaining)
			items.push(new Item('Remaining', { description: b.remaining, icon: 'history' }));
		if (b.log.length)
			items.push(new Item('Steps', {
				description: String(b.log.length), icon: 'list-ordered',
				children: b.log.map(l => {
					const m = /^(good|bad|skip|first bad commit): \[([0-9a-f]+)\] (.*)$/.exec(l);
					const kind = m ? m[1] : '';
					return new Item(m ? m[3] : l, {
						description: m ? `${kind} · ${m[2].slice(0, 12)}` : '',
						icon: kind === 'good' ? 'pass' : kind === 'bad' || kind === 'first bad commit' ? 'error' : 'debug-step-over',
						color: kind === 'good' ? 'testing.iconPassed' : kind === 'bad' ? 'problemsErrorIcon.foreground' : undefined,
						command: m ? { command: 'kernelDev.git.openCommit', title: 'Open Commit', arguments: [m[2]] } : undefined,
					});
				}),
			}));
		if (b.message && !b.result)
			items.push(new Item(b.message, { icon: 'info', tooltip: b.message }));
		return items;
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {Settings} s
 */
function registerBisect(context, s) {
	const bisect = new Bisect(context, s);
	const tree = new BisectTree(bisect);
	/** Ask for the bad and good commits and start. */
	const start = async () => {
		const bad = await vscode.window.showInputBox({ title: 'Bisect: bad commit (has the bug)', value: 'HEAD' });
		if (!bad)
			return false;
		const good = await vscode.window.showInputBox({ title: 'Bisect: good commit (works)', prompt: 'e.g. v6.12, or a commit hash' });
		if (!good)
			return false;
		await bisect.start(bad.trim(), good.trim());
		return bisect.active;
	};
	/** @type {[string, (...args: any[]) => any][]} */
	const commands = [
		['kernelDev.bisect.start', start],
		['kernelDev.bisect.good', () => bisect.step(['good'])],
		['kernelDev.bisect.bad', () => bisect.step(['bad'])],
		['kernelDev.bisect.skip', () => bisect.step(['skip'])],
		['kernelDev.bisect.reset', () => bisect.reset()],
		['kernelDev.bisect.run', async () => {
			if (!bisect.active && !await start())
				return;
			const uri = await vscode.window.showOpenDialog({ title: 'Test script: exit 0 = good, 1 = bad, 125 = skip; it gets the build directory',
				canSelectMany: false, defaultUri: vscode.Uri.file(s.root) });
			if (uri)
				await bisect.run(uri[0].fsPath);
		}],
		['kernelDev.bisect.copyFixes', async () => {
			if (!bisect.result)
				return;
			const line = await fixesLine(bisect.root, bisect.result.hash);
			await vscode.env.clipboard.writeText(line);
			vscode.window.showInformationMessage(`Copied: ${line}`);
		}],
	];
	const view = vscode.window.createTreeView('kernelDev.bisect', { treeDataProvider: tree });
	for (const [id, fn] of commands)
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	context.subscriptions.push(view, view.onDidChangeVisibility(() => view.visible && bisect.refresh()));
	bisect.refresh();
	return { bisect, view: tree };
}

module.exports = { Bisect, BisectTree, registerBisect };

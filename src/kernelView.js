// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { archInfo, isNative } = require('./arch');

/** @typedef {import('./settings').Settings} Settings */
/** @typedef {import('./runner').Runner} Runner */
/** @typedef {import('./kbuild').Kbuild} Kbuild */

/**
 * How an option is shown and edited.
 * @typedef {Object} OptionSpec
 * @property {string} key          kernelDev.<key>
 * @property {string} label
 * @property {'enum'|'bool'|'string'|'args'|'words'|'options'|'int'|'archString'|'archFile'} kind
 * @property {{ value: string, label: string }[]} [choices]   for 'enum'
 * @property {string} [placeholder]
 * @property {string} [tooltip]
 */

/** @type {OptionSpec[]} */
const OPTIONS = [
	{ key: 'toolchain', label: 'Toolchain', kind: 'enum', choices: [{ value: 'gcc', label: 'GCC' }, { value: 'llvm', label: 'LLVM (LLVM=1)' }] },
	{ key: 'crossCompile', label: 'CROSS_COMPILE', kind: 'archString', placeholder: 'empty: the default for the architecture' },
	{ key: 'make.ccache', label: 'ccache', kind: 'bool' },
	{ key: 'make.args', label: 'Extra make arguments', kind: 'args', placeholder: 'W=1 KCFLAGS=-Og' },
	{ key: 'configure.fragments', label: 'Config fragments', kind: 'words', placeholder: 'kernel/configs/debug.config' },
	{ key: 'configure.options', label: 'Config options', kind: 'options', placeholder: 'KASAN=y LOG_BUF_SHIFT=18' },
	{ key: 'terminal.afterTask', label: 'When a step finishes', kind: 'enum',
		choices: [{ value: 'waitForKey', label: 'Keep the terminal open' }, { value: 'close', label: 'Close the terminal' }] },
	{ key: 'run.mode', label: 'Boot with', kind: 'enum', choices: [{ value: 'qemu', label: 'QEMU' }, { value: 'virtme', label: 'virtme-ng' }] },
	{ key: 'run.initramfs', label: 'Initramfs', kind: 'archFile' },
	{ key: 'run.shareBuildDir', label: 'Share build directory with the guest', kind: 'bool' },
	{ key: 'run.cmdline', label: 'Kernel command line', kind: 'string', placeholder: 'loglevel=8' },
	{ key: 'run.qemuArgs', label: 'Extra QEMU arguments', kind: 'args', placeholder: '-device virtio-rng-pci' },
	{ key: 'run.memory', label: 'Memory', kind: 'string', placeholder: '2G' },
	{ key: 'run.smp', label: 'CPUs', kind: 'int' },
];

class Item extends vscode.TreeItem {
	/**
	 * @param {string} label
	 * @param {{ description?: string, icon?: string, color?: string, tooltip?: string | vscode.MarkdownString,
	 *           contextValue?: string, children?: Item[], collapsed?: boolean, option?: OptionSpec, command?: vscode.Command }} [o]
	 */
	constructor(label, o = {}) {
		super(label, o.children ? (o.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
			: vscode.TreeItemCollapsibleState.None);
		this.description = o.description;
		if (o.icon)
			this.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
		this.tooltip = o.tooltip;
		this.contextValue = o.contextValue;
		this.children = o.children;
		this.option = o.option;
		if (o.command)
			this.command = o.command;
	}
}

/**
 * The Kernel view: the target (architecture, Debug/Release, base config),
 * the state of each step, and the options the steps use. Values are
 * changed with the edit action on each item; Configure, Build, Run and
 * Debug are in the view's toolbar.
 * @implements {vscode.TreeDataProvider<Item>}
 */
class KernelView {
	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {Settings} s
	 * @param {Kbuild} kbuild
	 * @param {Runner} runner
	 */
	constructor(context, s, kbuild, runner) {
		this.s = s;
		this.kbuild = kbuild;
		this.runner = runner;
		/** @type {Set<vscode.TaskExecution>} kernel tasks whose process is running */
		this.running = new Set();
		/** @type {{ missing: string, cmd: string, list: string[] }} */
		this.tools = { missing: '', cmd: '', list: [] };
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		const refresh = () => this.refresh();
		s.onDidChange(refresh);
		context.subscriptions.push(
			this._onDidChangeTreeData,
			vscode.window.onDidOpenTerminal(refresh),
			vscode.window.onDidCloseTerminal(refresh),
			// Tracked from the events: when onDidEndTaskProcess fires the task
			// is still listed in vscode.tasks.taskExecutions.
			vscode.tasks.onDidStartTaskProcess(e => {
				if (e.execution.task.source === 'kernel')
					this.running.add(e.execution);
				this.refresh();
			}),
			vscode.tasks.onDidEndTaskProcess(e => { this.running.delete(e.execution); this.refresh(); }),
			vscode.tasks.onDidEndTask(e => { this.running.delete(e.execution); this.refresh(); }),
		);
	}

	refresh() {
		vscode.commands.executeCommand('setContext', 'kernelDev.busy', this.running.size > 0);
		this._onDidChangeTreeData.fire(undefined);
	}

	/** @param {string} missing @param {string} cmd @param {string[]} [list] */
	setTools(missing, cmd, list = []) {
		this.tools = { missing, cmd, list };
		this.refresh();
	}

	/** @param {Item} item */
	getTreeItem(item) {
		return item;
	}

	/** @param {Item} [item] */
	getChildren(item) {
		if (item)
			return item.children || [];
		return [this.targetGroup(), this.statusGroup(), this.optionsGroup()];
	}

	targetGroup() {
		const s = this.s;
		const configs = path.basename(s.config);
		return new Item('Target', {
			icon: 'target',
			children: [
				new Item('Architecture', { description: `${s.arch}${isNative(s.arch) ? '' : ' (cross)'}`, icon: 'chip',
					contextValue: 'edit', command: undefined, tooltip: 'kernelDev.arch', option: { key: '$arch', label: 'Architecture', kind: 'enum' } }),
				new Item('Build', { description: s.variant === 'debug' ? 'Debug' : 'Release', icon: s.variant === 'debug' ? 'bug' : 'rocket',
					contextValue: 'edit', option: { key: '$variant', label: 'Build', kind: 'enum' } }),
				new Item('Base config', { description: configs, icon: 'file-code', tooltip: s.config,
					contextValue: 'edit', option: { key: '$config', label: 'Base config', kind: 'enum' } }),
			],
		});
	}

	statusGroup() {
		const s = this.s;
		const state = s.configured();
		const mtime = (/** @type {string} */ f) => {
			try {
				return fs.statSync(f).mtime;
			} catch {
				return undefined;
			}
		};
		const when = (/** @type {Date | undefined} */ d) => d ? d.toLocaleString() : 'not yet';
		const built = state ? mtime(this.kbuild.image(state)) : undefined;
		const busy = [...this.running][0];
		/** @type {Item[]} */
		const items = [];
		if (busy)
			items.push(new Item('Running', { description: busy.task.name, icon: 'loading~spin' }));
		items.push(
			new Item('Configured', { description: state ? when(new Date(state.configuredAt)) : 'not yet',
				icon: state ? 'pass' : 'circle-large-outline', tooltip: state ? `From ${state.config}\n${state.buildDir}` : s.buildDir() }),
			new Item('Built', { description: built ? `${path.basename(this.kbuild.image(/** @type {any} */ (state)))}, ${when(built)}` : 'not yet',
				icon: built ? 'pass' : 'circle-large-outline' }),
			new Item('VM', { description: this.runner.running ? 'running' : 'stopped', icon: this.runner.running ? 'vm-running' : 'vm',
				contextValue: this.runner.running ? 'vmRunning' : undefined }),
		);
		const t = this.tools;
		items.push(t.missing
			? new Item('Tools', { description: `missing ${t.list.length || ''}`.trim(), icon: 'warning', color: 'problemsWarningIcon.foreground',
				tooltip: t.missing, contextValue: t.cmd ? 'toolsMissing' : undefined,
				children: t.list.map(m => new Item(m, { icon: 'circle-small' })), collapsed: true })
			: new Item('Tools', { description: 'all installed', icon: 'pass' }));
		return new Item('Status', { icon: 'pulse', children: items });
	}

	optionsGroup() {
		return new Item('Options', {
			icon: 'settings',
			collapsed: true,
			children: OPTIONS.map(o => new Item(o.label, {
				description: this.describe(o),
				tooltip: `kernelDev.${o.key}`,
				contextValue: 'edit',
				option: o,
			})),
		});
	}

	/** @param {OptionSpec} o */
	describe(o) {
		const s = this.s;
		const v = s.get(o.key, /** @type {any} */ (undefined));
		switch (o.kind) {
		case 'enum': return o.choices?.find(c => c.value === v)?.label || String(v ?? '');
		case 'bool': return v ? 'on' : 'off';
		case 'args': return joinArgs(v || []) || 'none';
		case 'words': return (v || []).join(' ') || 'none';
		case 'options': return Object.keys(v || {}).length ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join(' ') : 'none';
		case 'int': return String(v ?? '');
		case 'archString': return (v || {})[s.arch] ? `${(v || {})[s.arch]} (${s.arch})` : `default (${s.arch}: ${isNative(s.arch) ? 'native' : archInfo(s.arch).gccPrefix})`;
		case 'archFile': return (v || {})[s.arch] ? `${path.basename((v || {})[s.arch])} (${s.arch})` : `none (${s.arch})`;
		default: return String(v ?? '');
		}
	}
}

/**
 * Change an option, writing it where its current value comes from: the
 * workspace folder or workspace if set there, else user settings.
 * @param {Settings} s
 * @param {OptionSpec} o
 */
async function editOption(s, o) {
	const cfg = vscode.workspace.getConfiguration('kernelDev', s.folder.uri);
	const write = async (/** @type {any} */ value) => {
		const info = cfg.inspect(o.key);
		const target = info?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
			: info?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await cfg.update(o.key, value, target);
	};
	const current = s.get(o.key, /** @type {any} */ (undefined));
	const ask = (/** @type {string} */ value) => vscode.window.showInputBox({ title: o.label, value, placeHolder: o.placeholder, prompt: `kernelDev.${o.key}` });
	switch (o.kind) {
	case 'enum': {
		const pick = await vscode.window.showQuickPick((o.choices || []).map(c => ({ label: c.label, value: c.value, picked: c.value === current,
			description: c.value === current ? 'current' : '' })), { title: o.label });
		return pick && write(pick.value);
	}
	case 'bool':
		return write(!current);
	case 'int': {
		const v = await ask(String(current ?? ''));
		return v !== undefined && write(Math.max(1, parseInt(v, 10) || 1));
	}
	case 'string': {
		const v = await ask(current || '');
		return v !== undefined && write(v);
	}
	case 'args': {
		const v = await ask(joinArgs(current || []));
		return v !== undefined && write(splitArgs(v));
	}
	case 'words': {
		const v = await ask((current || []).join(' '));
		return v !== undefined && write(v.split(/\s+/).filter(Boolean));
	}
	case 'options': {
		const v = await ask(Object.entries(current || {}).map(([k, x]) => `${k}=${x}`).join(' '));
		if (v === undefined)
			return;
		/** @type {Record<string, string>} */
		const opts = {};
		for (const m of v.matchAll(/(?:CONFIG_)?(\w+)=("[^"]*"|\S+)/g))
			opts[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
		return write(opts);
	}
	case 'archString': {
		const v = await ask((current || {})[s.arch] || '');
		if (v === undefined)
			return;
		const map = { ...(current || {}) };
		if (v.trim()) map[s.arch] = v.trim(); else delete map[s.arch];
		return write(map);
	}
	case 'archFile': {
		const pick = await vscode.window.showQuickPick([
			{ label: '$(folder-opened) Choose a file…', value: 'browse' },
			{ label: '$(close) None: boot without an initramfs', value: 'none' },
		], { title: `${o.label} for ${s.arch}` });
		if (!pick)
			return;
		const map = { ...(current || {}) };
		if (pick.value === 'none') {
			delete map[s.arch];
		} else {
			const uri = await vscode.window.showOpenDialog({ title: `${o.label} for ${s.arch}`, canSelectMany: false });
			if (!uri)
				return;
			map[s.arch] = uri[0].fsPath;
		}
		return write(map);
	}
	}
}

/** Split a command-line-like string, honouring '…' and "…". @param {string} text */
function splitArgs(text) {
	const out = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	let m;
	while ((m = re.exec(text)))
		out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
	return out;
}

/** @param {string[]} args */
function joinArgs(args) {
	return args.map(a => /^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, '\\$1')}"`).join(' ');
}

/**
 * Register the Kernel view and its item actions.
 * @param {vscode.ExtensionContext} context
 * @param {Settings} s
 * @param {Kbuild} kbuild
 * @param {Runner} runner
 */
function registerKernelView(context, s, kbuild, runner) {
	const view = new KernelView(context, s, kbuild, runner);
	context.subscriptions.push(
		vscode.window.createTreeView('kernelDev.kernel', { treeDataProvider: view, showCollapseAll: false }),
		vscode.commands.registerCommand('kernelDev.editItem', async (/** @type {Item} */ item) => {
			const o = item?.option;
			if (!o)
				return;
			if (o.key === '$arch')
				return vscode.commands.executeCommand('kernelDev.selectArch');
			if (o.key === '$variant')
				return vscode.commands.executeCommand('kernelDev.selectVariant');
			if (o.key === '$config')
				return vscode.commands.executeCommand('kernelDev.selectConfig');
			await editOption(s, o);
		}),
	);
	return view;
}

module.exports = { KernelView, registerKernelView, editOption, splitArgs, joinArgs, OPTIONS };

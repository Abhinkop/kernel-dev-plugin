// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ARCHES, isNative } = require('./arch');
const { listConfigs, setConfig } = require('./ui');

/** @typedef {import('./settings').Settings} Settings */
/** @typedef {import('./runner').Runner} Runner */
/** @typedef {import('./kbuild').Kbuild} Kbuild */

/**
 * The Kernel panel in the activity bar: target selection (arch, variant,
 * config), the Configure / Build / Run / Debug buttons, the state of each
 * step, and the options those steps use.
 * @implements {vscode.WebviewViewProvider}
 */
class KernelPanel {
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
		/** @type {vscode.WebviewView | undefined} */
		this.view = undefined;
		/**
		 * Kernel tasks whose process is running. Tracked from the events
		 * because vscode.tasks.taskExecutions still lists a task when its
		 * process-end event fires, which left the buttons disabled.
		 * @type {Set<vscode.TaskExecution>}
		 */
		this.running = new Set();
		this.tools = { missing: '', cmd: '' };
		const push = () => this.push();
		s.onDidChange(push);
		context.subscriptions.push(
			vscode.window.onDidOpenTerminal(push),
			vscode.window.onDidCloseTerminal(push),
			vscode.tasks.onDidStartTaskProcess(e => {
				if (e.execution.task.source === 'kernel')
					this.running.add(e.execution);
				push();
			}),
			vscode.tasks.onDidEndTaskProcess(e => {
				this.running.delete(e.execution);
				push();
			}),
			vscode.tasks.onDidEndTask(e => {
				this.running.delete(e.execution);
				push();
			}),
		);
	}

	/** @param {vscode.WebviewView} view */
	resolveWebviewView(view) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = html(crypto.randomBytes(16).toString('base64'));
		view.webview.onDidReceiveMessage(m => this.onMessage(m));
		view.onDidChangeVisibility(() => this.push());
	}

	/** @param {any} m */
	async onMessage(m) {
		const s = this.s;
		switch (m.type) {
		case 'ready':
			return this.push();
		case 'command':
			return vscode.commands.executeCommand(m.command);
		case 'arch':
		case 'variant':
			await s.select(m.type, m.value);
			return vscode.commands.executeCommand('kernelDev.followSelection');
		case 'config':
			return setConfig(s, m.value === '$browse' ? undefined : m.value);
		case 'browseBusybox': {
			const uri = await vscode.window.showOpenDialog({ title: `Static busybox for ${s.arch}`, canSelectMany: false });
			if (uri)
				await this.update('run.busybox', { ...s.get('run.busybox', {}), [s.arch]: uri[0].fsPath });
			return;
		}
		case 'option':
			return this.saveOption(m.key, m.value);
		}
	}

	/**
	 * Options are written to user settings, so they apply to every kernel
	 * tree; a workspace value, if one exists, is updated instead.
	 * @param {string} key
	 * @param {any} value
	 */
	async update(key, value) {
		const cfg = vscode.workspace.getConfiguration('kernelDev', this.s.folder.uri);
		const info = cfg.inspect(key);
		const target = info && (info.workspaceFolderValue !== undefined) ? vscode.ConfigurationTarget.WorkspaceFolder
			: info && (info.workspaceValue !== undefined) ? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await cfg.update(key, value, target);
	}

	/** @param {string} key @param {string} text */
	async saveOption(key, text) {
		const s = this.s;
		switch (key) {
		case 'toolchain':
		case 'terminal.afterTask':
		case 'run.mode':
		case 'run.cmdline':
		case 'run.memory':
			return this.update(key, text);
		case 'run.smp':
			return this.update(key, Math.max(1, parseInt(text, 10) || 1));
		case 'make.args':
		case 'run.qemuArgs':
			return this.update(key, splitArgs(text));
		case 'configure.fragments':
			return this.update(key, text.split(/\s+/).filter(Boolean));
		case 'configure.options': {
			/** @type {Record<string, string>} */
			const opts = {};
			for (const line of text.split('\n')) {
				const m = /^\s*(?:CONFIG_)?(\w+)\s*=\s*(.*?)\s*$/.exec(line);
				if (m)
					opts[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
			}
			return this.update(key, opts);
		}
		case 'crossCompile':
			return this.update(key, { ...s.get('crossCompile', {}), [s.arch]: text });
		case 'run.busybox':
			return this.update(key, { ...s.get('run.busybox', {}), [s.arch]: text });
		}
	}

	/** @param {string} missing @param {string} cmd */
	setTools(missing, cmd) {
		this.tools = { missing, cmd };
		this.push();
	}

	push() {
		if (!this.view || !this.view.visible)
			return;
		const s = this.s;
		const state = s.configured();
		const mtime = (/** @type {string} */ f) => {
			try {
				return fs.statSync(f).mtime.toLocaleString();
			} catch {
				return '';
			}
		};
		const busy = [...this.running][0];
		this.view.webview.postMessage({
			type: 'state',
			arch: s.arch,
			arches: Object.keys(ARCHES).map(a => ({ value: a, label: `${a}${isNative(a) ? ' (native)' : ''}` })),
			variant: s.variant,
			config: s.config,
			configs: listConfigs(s).map(c => ({ value: c.value, label: path.basename(c.value) })),
			buildDir: s.buildDir(),
			configured: state ? new Date(state.configuredAt).toLocaleString() : '',
			configuredFrom: state ? state.config : '',
			built: state ? mtime(this.kbuild.image(state)) : '',
			vm: this.runner.running,
			busy: busy ? busy.task.name : '',
			tools: this.tools,
			options: {
				'toolchain': s.get('toolchain', 'gcc'),
				'terminal.afterTask': s.get('terminal.afterTask', 'waitForKey'),
				'crossCompile': s.get('crossCompile', /** @type {Record<string,string>} */ ({}))[s.arch] ?? '',
				'make.args': joinArgs(s.get('make.args', /** @type {string[]} */ ([]))),
				'configure.fragments': s.get('configure.fragments', /** @type {string[]} */ ([])).join(' '),
				'configure.options': Object.entries(s.get('configure.options', /** @type {Record<string,string>} */ ({})))
					.map(([k, v]) => `${k}=${v}`).join('\n'),
				'run.mode': s.get('run.mode', 'initramfs'),
				'run.busybox': s.get('run.busybox', /** @type {Record<string,string>} */ ({}))[s.arch] ?? '',
				'run.qemuArgs': joinArgs(s.get('run.qemuArgs', /** @type {string[]} */ ([]))),
				'run.cmdline': s.get('run.cmdline', ''),
				'run.memory': s.get('run.memory', '2G'),
				'run.smp': String(s.get('run.smp', 2)),
			},
		});
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

/** @param {string} nonce */
function html(nonce) {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body { padding: 4px 12px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
	h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 16px 0 6px; font-weight: 600; }
	label { display: block; margin: 8px 0 3px; color: var(--vscode-descriptionForeground); }
	select, input, textarea { width: 100%; box-sizing: border-box; padding: 4px 6px; font: inherit;
		color: var(--vscode-input-foreground); background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border, transparent)); border-radius: 2px; }
	select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border-color: var(--vscode-dropdown-border); }
	textarea { font-family: var(--vscode-editor-font-family); min-height: 4.5em; resize: vertical; }
	input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.row { display: flex; gap: 6px; } .row > * { flex: 1; } .row > .fit { flex: 0 0 auto; width: auto; }
	button { font: inherit; padding: 6px 8px; border: none; border-radius: 2px; cursor: pointer;
		color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button:disabled { opacity: .5; cursor: default; }
	.steps { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 4px; }
	.steps button { padding: 8px; font-weight: 600; }
	.tools { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; } .tools button { flex: 1; }
	.status { margin: 8px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; }
	.status dt { color: var(--vscode-descriptionForeground); } .status dd { margin: 0; overflow-wrap: anywhere; }
	.hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 3px; }
	.busy { color: var(--vscode-charts-yellow, var(--vscode-foreground)); }
	.missing { color: var(--vscode-errorForeground); }
	a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style></head>
<body>
	<h3>Target</h3>
	<label for="arch">Architecture</label>
	<select id="arch"></select>
	<label for="variant">Build</label>
	<select id="variant"><option value="debug">Debug</option><option value="release">Release</option></select>
	<label for="config">Base config</label>
	<div class="row"><select id="config"></select><button class="secondary fit" id="browseConfig" title="Use an existing .config file">…</button></div>

	<h3>Workflow</h3>
	<div class="steps">
		<button data-cmd="kernelDev.configure">⚙ Configure</button>
		<button data-cmd="kernelDev.build">🔨 Build</button>
		<button data-cmd="kernelDev.run">▶ Run</button>
		<button data-cmd="kernelDev.debug">🐞 Debug</button>
	</div>
	<div class="tools">
		<button class="secondary" data-cmd="kernelDev.menuconfig">menuconfig</button>
		<button class="secondary" data-cmd="kernelDev.clean">Clean</button>
		<button class="secondary" data-cmd="kernelDev.rebuild">Rebuild</button>
		<button class="secondary" data-cmd="kernelDev.mrproper" title="make mrproper">Full clean</button>
		<button class="secondary" id="stop" data-cmd="kernelDev.stop">■ Stop VM</button>
	</div>
	<dl class="status">
		<dt>Now</dt><dd id="task"></dd>
		<dt>Configured</dt><dd id="configured"></dd>
		<dt>Built</dt><dd id="built"></dd>
		<dt>VM</dt><dd id="vm"></dd>
		<dt>Build dir</dt><dd id="buildDir"></dd>
		<dt>Tools</dt><dd id="tools"></dd>
	</dl>
	<div class="tools" id="toolsActions">
		<button class="secondary" data-cmd="kernelDev.installTools" id="installTools">Install missing tools</button>
		<button class="secondary" data-cmd="kernelDev.checkTools">Check again</button>
	</div>

	<h3>Configure &amp; build options</h3>
	<label for="toolchain">Toolchain</label>
	<select id="toolchain" data-opt="toolchain"><option value="gcc">GCC</option><option value="llvm">LLVM (LLVM=1)</option></select>
	<label for="crossCompile">CROSS_COMPILE for <span class="archName"></span></label>
	<input id="crossCompile" data-opt="crossCompile" placeholder="default for this arch">
	<label for="makeArgs">Extra make arguments</label>
	<input id="makeArgs" data-opt="make.args" placeholder="W=1 KCFLAGS=-Og">
	<label for="fragments">Config fragments</label>
	<input id="fragments" data-opt="configure.fragments" placeholder="kernel/configs/debug.config">
	<label for="options">Config options (one per line)</label>
	<textarea id="options" data-opt="configure.options" placeholder="KASAN=y&#10;LOG_BUF_SHIFT=18"></textarea>
	<div class="hint">Changes apply at the next Configure.</div>
	<label for="afterTask">When a step finishes</label>
	<select id="afterTask" data-opt="terminal.afterTask"><option value="waitForKey">Keep terminal open (press a key to close)</option><option value="close">Close terminal</option></select>

	<h3>Run options</h3>
	<label for="mode">Boot with</label>
	<select id="mode" data-opt="run.mode"><option value="initramfs">Busybox initramfs</option><option value="virtme">virtme-ng (host rootfs)</option></select>
	<label for="busybox">Static busybox for <span class="archName"></span></label>
	<div class="row"><input id="busybox" data-opt="run.busybox" placeholder="busybox on PATH (host arch)"><button class="secondary fit" id="browseBusybox">…</button></div>
	<label for="cmdline">Kernel command line</label>
	<input id="cmdline" data-opt="run.cmdline" placeholder="loglevel=8">
	<label for="qemuArgs">Extra QEMU arguments</label>
	<input id="qemuArgs" data-opt="run.qemuArgs" placeholder="-device virtio-rng-pci">
	<div class="row">
		<div><label for="memory">Memory</label><input id="memory" data-opt="run.memory"></div>
		<div><label for="smp">CPUs</label><input id="smp" data-opt="run.smp" type="number" min="1"></div>
	</div>
	<p class="hint">Options are saved to your user settings and apply to every kernel tree. <a data-cmd="kernelDev.openSettings">All settings…</a></p>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);
	const fill = (sel, items, value) => {
		sel.replaceChildren(...items.map(i => new Option(i.label, i.value, false, i.value === value)));
	};
	document.querySelectorAll('[data-cmd]').forEach(el =>
		el.addEventListener('click', () => vscode.postMessage({ type: 'command', command: el.dataset.cmd })));
	$('arch').addEventListener('change', e => vscode.postMessage({ type: 'arch', value: e.target.value }));
	$('variant').addEventListener('change', e => vscode.postMessage({ type: 'variant', value: e.target.value }));
	$('config').addEventListener('change', e => vscode.postMessage({ type: 'config', value: e.target.value }));
	$('browseConfig').addEventListener('click', () => vscode.postMessage({ type: 'config', value: '$browse' }));
	$('browseBusybox').addEventListener('click', () => vscode.postMessage({ type: 'browseBusybox' }));
	document.querySelectorAll('[data-opt]').forEach(el =>
		el.addEventListener('change', () => vscode.postMessage({ type: 'option', key: el.dataset.opt, value: el.value })));

	window.addEventListener('message', ({ data: st }) => {
		if (st.type !== 'state') return;
		fill($('arch'), st.arches, st.arch);
		$('variant').value = st.variant;
		fill($('config'), st.configs, st.config);
		document.querySelectorAll('.archName').forEach(el => el.textContent = st.arch);
		$('configured').textContent = st.configured ? st.configured + ' (' + st.configuredFrom + ')' : 'not yet';
		$('built').textContent = st.built || 'not yet';
		$('vm').textContent = st.vm ? 'running' : 'stopped';
		$('buildDir').textContent = st.buildDir;
		$('tools').textContent = st.tools.missing ? 'missing ' + st.tools.missing : 'all installed';
		$('tools').className = st.tools.missing ? 'missing' : '';
		$('installTools').style.display = st.tools.cmd ? '' : 'none';
		$('toolsActions').style.display = st.tools.missing ? '' : 'none';
		$('stop').disabled = !st.vm;
		document.querySelectorAll('.steps button').forEach(b => b.disabled = !!st.busy);
		$('task').textContent = st.busy ? st.busy + '…' : 'idle';
		$('task').className = st.busy ? 'busy' : '';
		for (const el of document.querySelectorAll('[data-opt]'))
			if (document.activeElement !== el) el.value = st.options[el.dataset.opt];
	});
	vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}

module.exports = { KernelPanel, splitArgs, joinArgs };

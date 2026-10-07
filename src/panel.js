// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ARCHES, isNative } = require('./arch');
const { listConfigs, setConfig } = require('./ui');
const { page } = require('./webview');

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
		view.webview.html = html();
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
		case 'browseInitramfs': {
			const uri = await vscode.window.showOpenDialog({ title: `Initramfs for ${s.arch}`, canSelectMany: false });
			if (uri)
				await this.update('run.initramfs', { ...s.get('run.initramfs', {}), [s.arch]: uri[0].fsPath });
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
		case 'make.ccache':
		case 'run.shareBuildDir':
			return this.update(key, !!text);
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
		case 'run.initramfs': {
			/** @type {Record<string, string>} */
			const map = { ...s.get('run.initramfs', {}) };
			if (text.trim())
				map[s.arch] = text.trim();
			else
				delete map[s.arch];
			return this.update(key, map);
		}
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
				'run.mode': s.get('run.mode', 'qemu'),
				'run.initramfs': s.get('run.initramfs', /** @type {Record<string,string>} */ ({}))[s.arch] ?? '',
				'run.qemuArgs': joinArgs(s.get('run.qemuArgs', /** @type {string[]} */ ([]))),
				'run.cmdline': s.get('run.cmdline', ''),
				'run.memory': s.get('run.memory', '2G'),
				'run.smp': String(s.get('run.smp', 2)),
				'run.shareBuildDir': s.get('run.shareBuildDir', false),
				'make.ccache': s.get('make.ccache', false),
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

function html() {
	return page(`	<h3>Target</h3>
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
	<label class="check"><input type="checkbox" id="ccache" data-opt="make.ccache"> Use ccache</label>
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
	<select id="mode" data-opt="run.mode"><option value="qemu">QEMU</option><option value="virtme">virtme-ng (host rootfs)</option></select>
	<label for="initramfs">Initramfs for <span class="archName"></span></label>
	<div class="row"><input id="initramfs" data-opt="run.initramfs" placeholder="none: boot without initramfs"><button class="secondary fit" id="browseInitramfs">…</button></div>
	<label for="cmdline">Kernel command line</label>
	<input id="cmdline" data-opt="run.cmdline" placeholder="loglevel=8">
	<label for="qemuArgs">Extra QEMU arguments</label>
	<input id="qemuArgs" data-opt="run.qemuArgs" placeholder="-device virtio-rng-pci">
	<div class="row">
		<div><label for="memory">Memory</label><input id="memory" data-opt="run.memory"></div>
		<div><label for="smp">CPUs</label><input id="smp" data-opt="run.smp" type="number" min="1"></div>
	</div>
	<label class="check"><input type="checkbox" id="shareBuildDir" data-opt="run.shareBuildDir"> Share the build directory with the guest (9p, for insmod)</label>
	<p class="hint">Options are saved to your user settings and apply to every kernel tree. <a data-cmd="kernelDev.openSettings">All settings…</a></p>
`, `
	const fill = (sel, items, value) => {
		sel.replaceChildren(...items.map(i => new Option(i.label, i.value, false, i.value === value)));
	};
	$('arch').addEventListener('change', e => vscode.postMessage({ type: 'arch', value: e.target.value }));
	$('variant').addEventListener('change', e => vscode.postMessage({ type: 'variant', value: e.target.value }));
	$('config').addEventListener('change', e => vscode.postMessage({ type: 'config', value: e.target.value }));
	$('browseConfig').addEventListener('click', () => vscode.postMessage({ type: 'config', value: '$browse' }));
	$('browseInitramfs').addEventListener('click', () => vscode.postMessage({ type: 'browseInitramfs' }));
	document.querySelectorAll('[data-opt]').forEach(el =>
		el.addEventListener('change', () => vscode.postMessage({ type: 'option', key: el.dataset.opt, value: el.type === 'checkbox' ? el.checked : el.value })));

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
			if (document.activeElement !== el) {
				if (el.type === 'checkbox') el.checked = !!st.options[el.dataset.opt];
				else el.value = st.options[el.dataset.opt];
			}
	});
	vscode.postMessage({ type: 'ready' });
`);
}

module.exports = { KernelPanel, splitArgs, joinArgs, html };

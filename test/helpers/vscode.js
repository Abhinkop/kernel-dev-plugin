'use strict';

// A small, behaving stand-in for the `vscode` module, so the extension's
// modules can be unit-tested under plain node. It keeps state that tests
// can inspect (messages shown, diagnostics, commands executed, settings)
// and answers prompts from a queue (`mock.answer(...)`).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class EventEmitter {
	constructor() {
		this.listeners = [];
		this.event = (f) => {
			this.listeners.push(f);
			return { dispose: () => { this.listeners = this.listeners.filter(l => l !== f); } };
		};
	}
	fire(v) { for (const f of [...this.listeners]) f(v); }
	dispose() { this.listeners = []; }
}

class Uri {
	constructor(scheme, p, query = '', fragment = '') {
		this.scheme = scheme;
		this.path = p;
		this.query = query;
		this.fragment = fragment;
	}
	get fsPath() { return this.path; }
	static file(p) { return new Uri('file', path.resolve(p)); }
	static parse(s) {
		const m = /^([\w+.-]+):(.*?)(?:\?([^#]*))?(?:#(.*))?$/.exec(s);
		return new Uri(m[1], m[2], m[3] || '', m[4] || '');
	}
	static from(o) { return new Uri(o.scheme, o.path || '', o.query || '', o.fragment || ''); }
	with(o) { return new Uri(o.scheme ?? this.scheme, o.path ?? this.path, o.query ?? this.query, o.fragment ?? this.fragment); }
	toString() { return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`; }
}

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
	constructor(a, b, c, d) {
		if (a instanceof Position) { this.start = a; this.end = b; return; }
		this.start = new Position(a, b);
		this.end = new Position(c, d);
	}
}
class Selection extends Range {
	constructor(a, b, c, d) {
		if (a instanceof Position) { super(a, b); this.anchor = a; this.active = b; return; }
		super(a, b, c, d);
		this.anchor = this.start;
		this.active = this.end;
	}
	get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString {
	constructor(v = '') { this.value = v; this.isTrusted = false; }
	appendMarkdown(s) { this.value += s; return this; }
}
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class InlayHintLabelPart { constructor(value) { this.value = value; } }
class InlayHint { constructor(position, label, kind) { this.position = position; this.label = label; this.kind = kind; } }
class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
class TestMessage { constructor(message) { this.message = message; } }
class TestRunRequest { constructor(include, exclude) { this.include = include; this.exclude = exclude; } }
class CancellationTokenSource {
	constructor() {
		const listeners = [];
		this.token = {
			isCancellationRequested: false,
			onCancellationRequested: (f) => { listeners.push(f); return { dispose() {} }; },
		};
		this._listeners = listeners;
	}
	cancel() { this.token.isCancellationRequested = true; for (const f of this._listeners) f(); }
	dispose() {}
}
class ProcessExecution { constructor(process, args, options) { this.process = process; this.args = args; this.options = options || {}; } }
class Task {
	constructor(definition, scope, name, source, execution, problemMatchers) {
		Object.assign(this, { definition, scope, name, source, execution, problemMatchers });
	}
}

const state = {
	/** answers for show*Message / showQuickPick / showInputBox / showOpenDialog, in order */
	answers: [],
	/** everything shown or asked */
	log: [],
	/** settings: 'kernelDev.x' -> value */
	config: {},
	commands: new Map(),
	executed: [],
	diagnostics: new Map(),
	providers: {},
	clipboard: '',
	terminals: [],
	tasks: [],
	/** set by tests to let executeTask actually run the process */
	runTasks: true,
	debugSessions: [],
};

function ask(kind, message, items, options) {
	state.log.push({ kind, message, items, options });
	let a = state.answers.length ? state.answers.shift() : undefined;
	if (typeof a === 'function')
		a = a(items, message, options);
	return Promise.resolve(a);
}

const onDidChangeConfiguration = new EventEmitter();
const onDidSaveTextDocument = new EventEmitter();
const onDidChangeTextDocument = new EventEmitter();
const onDidEndTaskProcess = new EventEmitter();
const onDidStartTaskProcess = new EventEmitter();
const onDidEndTask = new EventEmitter();
const onDidCloseTerminal = new EventEmitter();
const onDidOpenTerminal = new EventEmitter();
const onDidChangeActiveTextEditor = new EventEmitter();
const onDidChangeTextEditorSelection = new EventEmitter();
const onDidTerminateDebugSession = new EventEmitter();

// Setting defaults, as VS Code takes them from the manifest.
const DEFAULTS = {};
for (const sec of require('../../package.json').contributes.configuration)
	for (const [k, v] of Object.entries(sec.properties))
		DEFAULTS[k] = v.default;

function configuration(section) {
	const key = (k) => (section ? `${section}.${k}` : k);
	return {
		get: (k, d) => (state.config[key(k)] !== undefined ? state.config[key(k)] : DEFAULTS[key(k)] !== undefined ? DEFAULTS[key(k)] : d),
		has: (k) => state.config[key(k)] !== undefined,
		inspect: (k) => ({ key: key(k), globalValue: state.config[key(k)] }),
		update: async (k, v) => {
			if (v === undefined) delete state.config[key(k)]; else state.config[key(k)] = v;
			onDidChangeConfiguration.fire({ affectsConfiguration: (s) => key(k).startsWith(s) });
		},
	};
}

/** A minimal TextDocument over a string. */
function textDocument(uri, text, extra = {}) {
	const lines = () => text.split('\n');
	return {
		uri, isDirty: false, languageId: 'plaintext', ...extra,
		getText: (range) => {
			if (!range) return text;
			const l = lines();
			return l.slice(range.start.line, range.end.line + 1).join('\n');
		},
		get lineCount() { return lines().length; },
		lineAt: (i) => ({ text: lines()[i] ?? '' }),
	};
}

class TestItemCollection {
	constructor() { this.map = new Map(); }
	add(i) { this.map.set(i.id, i); }
	replace(items) { this.map = new Map(items.map(i => [i.id, i])); }
	get(id) { return this.map.get(id); }
	forEach(f) { this.map.forEach(v => f(v, this)); }
	get size() { return this.map.size; }
}

const vscode = {
	EventEmitter, Uri, Position, Range, Selection, ThemeIcon, ThemeColor, MarkdownString, TreeItem, Diagnostic,
	InlayHint, InlayHintLabelPart, DocumentLink, Location, TestMessage, TestRunRequest, CancellationTokenSource,
	ProcessExecution, Task,
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
	ViewColumn: { Active: -1, Beside: -2, One: 1 },
	TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
	TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
	TaskGroup: { Build: { id: 'build' }, Test: { id: 'test' } },
	TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
	TextEditorRevealType: { Default: 0, InCenter: 1 },

	workspace: {
		workspaceFolders: [],
		getConfiguration: (section) => configuration(section),
		onDidChangeConfiguration: onDidChangeConfiguration.event,
		onDidSaveTextDocument: onDidSaveTextDocument.event,
		onDidChangeTextDocument: onDidChangeTextDocument.event,
		registerTextDocumentContentProvider: (scheme, provider) => {
			state.providers[scheme] = provider;
			return { dispose() {} };
		},
		openTextDocument: async (arg) => {
			if (arg && arg.content !== undefined)
				return textDocument(Uri.from({ scheme: 'untitled', path: `/Untitled-${state.log.length}` }), arg.content, { languageId: arg.language });
			const uri = arg;
			if (uri.scheme === 'file')
				return textDocument(uri, fs.readFileSync(uri.fsPath, 'utf8'));
			const provider = state.providers[uri.scheme];
			return textDocument(uri, provider ? await provider.provideTextDocumentContent(uri) : '');
		},
		createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
	},

	window: {
		showInformationMessage: (m, ...i) => ask('info', m, i.filter(x => typeof x === 'string'), i.find(x => typeof x === 'object')),
		showWarningMessage: (m, ...i) => ask('warning', m, i.filter(x => typeof x === 'string'), i.find(x => typeof x === 'object')),
		showErrorMessage: (m, ...i) => ask('error', m, i.filter(x => typeof x === 'string'), i.find(x => typeof x === 'object')),
		showQuickPick: (items, o) => Promise.resolve(items).then(it => ask('quickpick', o && o.title, it, o)),
		showInputBox: (o) => ask('input', o && (o.title || o.prompt), [], o),
		showOpenDialog: (o) => ask('open', o && o.title, [], o),
		showTextDocument: async (doc, o) => {
			const d = doc.uri ? doc : await vscode.workspace.openTextDocument(doc);
			const editor = { document: d, selection: new Selection(0, 0, 0, 0), revealRange() {}, setDecorations() {}, options: o };
			vscode.window.activeTextEditor = editor;
			state.log.push({ kind: 'show', uri: String(d.uri), options: o });
			return editor;
		},
		withProgress: async (o, f) => f({ report() {} }, new CancellationTokenSource().token),
		get terminals() { return state.terminals.filter(t => !t.disposed); },
		createTerminal: (o) => {
			const t = { name: o.name, options: o, exitStatus: undefined, shown: false, sent: [], disposed: false,
				show() { this.shown = true; }, sendText(s) { this.sent.push(s); }, dispose() { this.disposed = true; onDidCloseTerminal.fire(this); } };
			state.terminals.push(t);
			onDidOpenTerminal.fire(t);
			return t;
		},
		createTreeView: (id, o) => {
			const view = { id, provider: o.treeDataProvider, visible: true, message: undefined, description: undefined, title: undefined,
				onDidChangeVisibility: () => ({ dispose() {} }), reveal: async () => {}, dispose() {} };
			state.providers[`tree:${id}`] = view;
			return view;
		},
		registerTreeDataProvider: (id, p) => { state.providers[`tree:${id}`] = { provider: p }; return { dispose() {} }; },
		registerWebviewViewProvider: () => ({ dispose() {} }),
		createTextEditorDecorationType: (o) => ({ options: o, dispose() {} }),
		onDidCloseTerminal: onDidCloseTerminal.event,
		onDidOpenTerminal: onDidOpenTerminal.event,
		onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
		onDidChangeTextEditorSelection: onDidChangeTextEditorSelection.event,
		activeTextEditor: undefined,
		visibleTextEditors: [],
		tabGroups: { all: [] },
	},

	languages: {
		createDiagnosticCollection: (name) => ({
			name,
			set: (uri, list) => state.diagnostics.set(`${name}|${uri.fsPath}`, list),
			delete: (uri) => state.diagnostics.delete(`${name}|${uri.fsPath}`),
			clear: () => { for (const k of [...state.diagnostics.keys()]) if (k.startsWith(`${name}|`)) state.diagnostics.delete(k); },
			forEach: (f) => { for (const [k, v] of state.diagnostics) if (k.startsWith(`${name}|`)) f(Uri.file(k.split('|')[1]), v); },
			dispose() {},
		}),
		registerInlayHintsProvider: (sel, p) => { state.providers.inlayHints = p; return { dispose() {} }; },
		registerDocumentLinkProvider: (sel, p) => { state.providers.documentLinks = p; return { dispose() {} }; },
		registerHoverProvider: () => ({ dispose() {} }),
		setTextDocumentLanguage: async (d) => d,
	},

	commands: {
		registerCommand: (id, f) => {
			state.commands.set(id, f);
			return { dispose: () => state.commands.delete(id) };
		},
		executeCommand: async (id, ...args) => {
			state.executed.push({ id, args });
			const f = state.commands.get(id);
			return f ? f(...args) : undefined;
		},
		getCommands: async () => [...state.commands.keys()],
	},

	tasks: {
		onDidEndTaskProcess: onDidEndTaskProcess.event,
		onDidStartTaskProcess: onDidStartTaskProcess.event,
		onDidEndTask: onDidEndTask.event,
		taskExecutions: [],
		/** Runs a ProcessExecution for real (unless state.runTasks is false) and reports its exit code. */
		executeTask: async (task) => {
			const execution = { task };
			state.tasks.push(task);
			// Like VS Code, a dedicated terminal named after the task, reused.
			if (!vscode.window.terminals.some(t => t.name === task.name))
				vscode.window.createTerminal({ name: task.name });
			setImmediate(() => {
				onDidStartTaskProcess.fire({ execution, processId: 1 });
				const finish = (code) => {
					task.exitCode = code;
					onDidEndTaskProcess.fire({ execution, exitCode: code });
					onDidEndTask.fire({ execution });
				};
				if (!state.runTasks || !(task.execution instanceof ProcessExecution))
					return finish(typeof state.runTasks === 'number' ? state.runTasks : 0);
				const e = task.execution;
				const child = spawn(e.process, e.args, { cwd: e.options.cwd, env: { ...process.env, ...(e.options.env || {}) } });
				let out = '';
				child.stdout.on('data', d => { out += d; });
				child.stderr.on('data', d => { out += d; });
				child.on('close', code => { task.output = out; finish(code ?? 1); });
			});
			return execution;
		},
	},

	debug: {
		onDidTerminateDebugSession: onDidTerminateDebugSession.event,
		startDebugging: async (folder, config) => { state.debugSessions.push(config); return true; },
	},

	extensions: { getExtension: (id) => state.extensions?.[id] },

	env: {
		clipboard: {
			readText: async () => state.clipboard,
			writeText: async (t) => { state.clipboard = t; },
		},
		openExternal: async (uri) => { state.log.push({ kind: 'openExternal', uri: String(uri) }); return true; },
	},

	tests: {
		createTestController: (id, label) => ({
			id, label, items: new TestItemCollection(), profiles: [], refreshHandler: undefined,
			createRunProfile(label, kind, handler) { const p = { label, kind, handler }; this.profiles.push(p); return p; },
			createTestItem: (id, label, uri) => ({ id, label, uri, children: new TestItemCollection() }),
			createTestRun: (request) => {
				const run = { request, results: [], output: '',
					passed(t) { run.results.push(['passed', t.id]); }, failed(t, m) { run.results.push(['failed', t.id, m]); },
					skipped(t) { run.results.push(['skipped', t.id]); }, errored(t, m) { run.results.push(['errored', t.id, m]); },
					started() {}, enqueued() {}, appendOutput(s) { run.output += s; }, end() { state.testRuns.push(run); } };
				return run;
			},
			dispose() {},
		}),
	},
};
state.testRuns = [];

/** Reset everything between tests. */
function reset() {
	Object.assign(state, {
		answers: [], log: [], config: {}, executed: [], clipboard: '', terminals: [], tasks: [], runTasks: true,
		debugSessions: [], testRuns: [], extensions: {},
	});
	state.commands.clear();
	state.diagnostics.clear();
	for (const k of Object.keys(state.providers)) delete state.providers[k];
	vscode.window.activeTextEditor = undefined;
	vscode.window.visibleTextEditors = [];
	vscode.workspace.workspaceFolders = [];
	for (const e of [onDidChangeConfiguration, onDidSaveTextDocument, onDidChangeTextDocument, onDidEndTaskProcess, onDidStartTaskProcess,
		onDidEndTask, onDidCloseTerminal, onDidOpenTerminal, onDidChangeActiveTextEditor, onDidChangeTextEditorSelection, onDidTerminateDebugSession])
		e.listeners = [];
}

/** Queue answers for the next prompts (a function gets the offered items). */
function answer(...a) {
	state.answers.push(...a);
}

module.exports = {
	vscode, state, reset, answer, textDocument,
	events: { onDidChangeConfiguration, onDidSaveTextDocument, onDidChangeTextDocument, onDidEndTaskProcess,
		onDidCloseTerminal, onDidChangeActiveTextEditor, onDidChangeTextEditorSelection, onDidTerminateDebugSession },
};

// @ts-check
'use strict';

const vscode = require('vscode');

const TASK_TYPE = 'kernel';

/**
 * Whether a step's terminal stays after it succeeds. A failed step's
 * terminal always stays, so its errors can be read. "waitForKey" and
 * "close" are the values of earlier versions.
 * @param {vscode.WorkspaceFolder} folder
 */
function keepTerminal(folder) {
	return vscode.workspace.getConfiguration('kernelDev', folder.uri).get('terminal.afterTask') === 'keep';
}

/**
 * The terminal a task ran in: VS Code names it after the task, with a
 * "Task - " prefix in some versions.
 * @param {string} name
 */
function taskTerminal(name) {
	return vscode.window.terminals.find(t => t.name === name || t.name === `Task - ${name}`);
}

/**
 * Run a command as a VS Code task (output in the terminal panel, problem
 * matcher applied) and resolve with its exit code. The terminal closes
 * when the step succeeds, unless kernelDev.terminal.afterTask is "keep";
 * it stays when the step fails.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {{ problemMatcher?: string[], cwd?: string, env?: Record<string,string>, reveal?: vscode.TaskRevealKind, step?: string }} [opts]
 * @returns {Promise<number>}
 */
async function runTask(folder, name, command, args, opts = {}) {
	const task = makeTask(folder, name, command, args, opts);
	const execution = await vscode.tasks.executeTask(task);
	return new Promise(resolve => {
		const sub = vscode.tasks.onDidEndTaskProcess(e => {
			if (e.execution === execution) {
				sub.dispose();
				const code = e.exitCode ?? 1;
				if (code === 0 && !keepTerminal(folder))
					taskTerminal(name)?.dispose();
				resolve(code);
			}
		});
	});
}

/**
 * @param {vscode.WorkspaceFolder} folder
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {{ problemMatcher?: string[], cwd?: string, env?: Record<string,string>, reveal?: vscode.TaskRevealKind, step?: string }} [opts]
 */
function makeTask(folder, name, command, args, opts = {}) {
	const task = new vscode.Task(
		{ type: TASK_TYPE, step: opts.step || name },
		folder,
		name,
		'kernel',
		new vscode.ProcessExecution(command, args, { cwd: opts.cwd || folder.uri.fsPath, env: opts.env }),
		opts.problemMatcher || [],
	);
	task.presentationOptions = {
		reveal: opts.reveal ?? vscode.TaskRevealKind.Always,
		panel: vscode.TaskPanelKind.Dedicated,
		clear: true,
		showReuseMessage: false,
		// runTask() closes the terminal of a step that succeeded.
		close: false,
	};
	return task;
}

/**
 * Shell-quote for display / for `bash -c` strings.
 * @param {string} s
 */
function sq(s) {
	return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = { runTask, makeTask, sq, keepTerminal, taskTerminal, TASK_TYPE };

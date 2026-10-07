// @ts-check
'use strict';

const vscode = require('vscode');

const TASK_TYPE = 'kernel';

/**
 * Run a command as a VS Code task (output in the terminal panel, problem
 * matcher applied) and resolve with its exit code.
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
				resolve(e.exitCode ?? 1);
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
	const close = vscode.workspace.getConfiguration('kernelDev').get('terminal.afterTask') === 'close';
	task.presentationOptions = {
		reveal: opts.reveal ?? vscode.TaskRevealKind.Always,
		panel: vscode.TaskPanelKind.Dedicated,
		clear: true,
		// waitForKey: the terminal stays with "press any key to close it".
		showReuseMessage: !close,
		close,
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

module.exports = { runTask, makeTask, sq, TASK_TYPE };

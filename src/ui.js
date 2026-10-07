// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ARCHES, archInfo, isNative } = require('./arch');

/** @typedef {import('./settings').Settings} Settings */
/** @typedef {import('./runner').Runner} Runner */

/**
 * Mirror the selection into context keys, so the editor toolbar's target
 * menu can show checkmarks and the Stop button only while a VM runs.
 * @param {vscode.ExtensionContext} context
 * @param {Settings} s
 * @param {Runner} runner
 */
function syncContextKeys(context, s, runner) {
	const update = () => {
		vscode.commands.executeCommand('setContext', 'kernelDev.arch', s.arch);
		vscode.commands.executeCommand('setContext', 'kernelDev.variant', s.variant);
		vscode.commands.executeCommand('setContext', 'kernelDev.vmRunning', runner.running);
	};
	s.onDidChange(update);
	context.subscriptions.push(
		vscode.window.onDidOpenTerminal(update),
		vscode.window.onDidCloseTerminal(update),
	);
	update();
}

/**
 * Base configs offered for the current arch.
 * @param {Settings} s
 * @returns {{ value: string, description: string }[]}
 */
function listConfigs(s) {
	const karch = archInfo(s.arch).kernelArch;
	/** @type {string[]} */
	let archConfigs = [];
	try {
		archConfigs = fs.readdirSync(path.join(s.root, 'arch', karch, 'configs')).filter(f => f.endsWith('_defconfig')).sort();
	} catch {}
	const list = [
		{ value: 'defconfig', description: 'architecture default' },
		...archConfigs.map(c => ({ value: c, description: `arch/${karch}/configs` })),
		{ value: 'tinyconfig', description: 'smallest kernel' },
		{ value: 'allnoconfig', description: '' },
	];
	if (!list.some(c => c.value === s.config))
		list.unshift({ value: s.config, description: 'current' });
	return list;
}

/** @param {Settings} s */
async function pickArch(s) {
	const pick = await vscode.window.showQuickPick(Object.keys(ARCHES).map(a => ({
		label: a,
		description: (isNative(a) ? 'native' : 'cross') + (a === s.arch ? ' · current' : ''),
	})), { title: 'Kernel architecture' });
	if (pick)
		await s.select('arch', pick.label);
}

/** @param {Settings} s */
async function pickVariant(s) {
	const pick = await vscode.window.showQuickPick([
		{ label: 'Debug', description: 'debug info, gdb scripts', value: 'debug' },
		{ label: 'Release', description: 'no debug info', value: 'release' },
	], { title: 'Build variant' });
	if (pick)
		await s.select('variant', pick.value);
}

/** @param {Settings} s */
async function pickConfig(s) {
	const browse = '$(folder-opened) Existing .config file…';
	const pick = await vscode.window.showQuickPick(
		[...listConfigs(s).map(c => ({ label: c.value, description: c.description })), { label: browse, description: '' }],
		{ title: `Base config for ${s.arch}`, matchOnDescription: true });
	if (!pick)
		return;
	await setConfig(s, pick.label === browse ? undefined : pick.label);
}

/**
 * @param {Settings} s
 * @param {string} [value] undefined: ask for a file
 */
async function setConfig(s, value) {
	if (value === undefined) {
		const uri = await vscode.window.showOpenDialog({ title: 'Base .config', canSelectMany: false });
		if (!uri)
			return;
		value = uri[0].fsPath;
	}
	await s.select('config', value);
	if (s.configured())
		vscode.window.showInformationMessage(`Kernel: base config is now ${path.basename(value)}. Configure to apply it.`, 'Configure')
			.then(c => c && vscode.commands.executeCommand('kernelDev.configure'));
}

module.exports = { syncContextKeys, listConfigs, pickArch, pickVariant, pickConfig, setConfig };

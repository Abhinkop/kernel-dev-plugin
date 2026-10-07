'use strict';

// Records how long UI elements and actions take in the integration tests.

const fs = require('fs');
const path = require('path');

/** @type {{ area: string, what: string, ms: number, note: string }[]} */
const rows = [];

/**
 * Time an async action.
 * @template T
 * @param {string} area @param {string} what @param {() => Promise<T>} fn @param {(r: T) => string} [note]
 * @returns {Promise<T>}
 */
async function time(area, what, fn, note) {
	const t0 = process.hrtime.bigint();
	const r = await fn();
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	rows.push({ area, what, ms: Math.round(ms * 10) / 10, note: note ? note(r) : '' });
	return r;
}

/** Wait until cond() is truthy, polling; returns the elapsed milliseconds. */
async function until(cond, timeout = 60000, step = 25) {
	const t0 = Date.now();
	while (!(await cond())) {
		if (Date.now() - t0 > timeout)
			throw new Error(`timed out after ${timeout}ms`);
		await new Promise(r => setTimeout(r, step));
	}
	return Date.now() - t0;
}

function write(dir) {
	if (!dir)
		return;
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'ui-performance.json'), JSON.stringify(rows, null, 2) + '\n');
	const vscode = require('vscode');
	const md = [
		'# UI performance',
		'',
		`VS Code ${vscode.version}, ${new Date().toISOString().slice(0, 10)}, kernel tree ${process.env.KWB_TREE ? path.basename(process.env.KWB_TREE) : ''}.`,
		'Times are wall-clock in the extension host, measured by the integration tests.',
		'',
		'| Area | Action | Time | Note |',
		'|---|---|---:|---|',
		...rows.map(r => `| ${r.area} | ${r.what} | ${r.ms >= 1000 ? `${(r.ms / 1000).toFixed(2)} s` : `${r.ms} ms`} | ${r.note} |`),
		'',
	].join('\n');
	fs.writeFileSync(path.join(dir, 'ui-performance.md'), md);
}

module.exports = { time, until, write, rows };

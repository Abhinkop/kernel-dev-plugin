'use strict';

// Turns c8's json-summary into test-results/coverage.md.

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || 'coverage/coverage-summary.json';
const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
const root = path.resolve(__dirname, '..');
const pct = (m) => `${m.pct.toFixed(1)}%`;
const rows = Object.entries(summary)
	.filter(([k]) => k !== 'total')
	.map(([k, v]) => [path.relative(root, k), v])
	.sort((a, b) => a[0].localeCompare(b[0]));
const t = summary.total;
console.log([
	'# Coverage',
	'',
	'Unit tests and integration tests in VS Code, combined (c8).',
	'',
	'| File | Lines | Branches | Functions |',
	'|---|---:|---:|---:|',
	...rows.map(([f, v]) => `| ${f} | ${pct(v.lines)} | ${pct(v.branches)} | ${pct(v.functions)} |`),
	`| **Total** | **${pct(t.lines)}** | **${pct(t.branches)}** | **${pct(t.functions)}** |`,
	'',
].join('\n'));

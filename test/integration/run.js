'use strict';

// Runs the integration tests in a real VS Code (downloaded by
// @vscode/test-electron) against a throwaway clone of a kernel tree.
//
//   KWB_KERNEL_TREE  kernel source tree to clone (default ../linux-playground)
//   KWB_E2E=1        also configure, build and boot a kernel (slow)
//   NODE_V8_COVERAGE where the extension host writes coverage data

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');

const ext = path.resolve(__dirname, '../..');
const source = path.resolve(process.env.KWB_KERNEL_TREE || path.join(ext, '../linux-playground'));

function git(cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
	if (!fs.existsSync(path.join(source, 'Kbuild')))
		throw new Error(`KWB_KERNEL_TREE=${source} is not a kernel source tree`);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-it-'));
	const tree = path.join(work, 'linux');
	// --shared: the clone borrows the source tree's objects, so it is quick
	// and the source tree is never written to.
	git(work, 'clone', '-q', '--shared', source, tree);
	git(tree, 'config', 'user.name', 'Kernel Workbench Test');
	git(tree, 'config', 'user.email', 'test@example.com');
	git(tree, 'checkout', '-q', '-B', 'kwb-test-base', 'HEAD');

	// A maximized window on the 1600x1000 Xvfb screen (test/ci.sh), so
	// terminals are as large as on a desktop (menuconfig needs 19x80).
	fs.mkdirSync(path.join(work, 'user', 'User'), { recursive: true });
	fs.writeFileSync(path.join(work, 'user', 'User', 'settings.json'), JSON.stringify({ 'window.newWindowDimensions': 'maximized' }));
	const results = path.join(ext, 'test-results');
	fs.mkdirSync(results, { recursive: true });
	const version = process.env.KWB_VSCODE_VERSION || 'stable';
	const vscodeExecutablePath = await downloadAndUnzipVSCode(version);
	// Only the extension under test, plus for the end-to-end run the
	// C/C++ extension, for a real debug session. It is kept between runs;
	// if the Marketplace cannot be reached the debugger test is skipped.
	let extensions = path.join(work, 'extensions');
	fs.mkdirSync(extensions);
	if (process.env.KWB_E2E === '1') {
		extensions = path.join(ext, '.vscode-test', 'extensions-e2e');
		fs.mkdirSync(extensions, { recursive: true });
		if (!fs.readdirSync(extensions).some(d => d.startsWith('ms-vscode.cpptools-'))) {
			const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
			try {
				execFileSync(cli, [...cliArgs.filter(a => !a.startsWith('--extensions-dir')), '--extensions-dir', extensions,
					'--install-extension', 'ms-vscode.cpptools'], { stdio: 'inherit' });
			} catch (e) {
				console.warn(`Could not install ms-vscode.cpptools (${e.message.split('\n')[0]}); the real-debugger test is skipped.`);
			}
		}
	}
	await runTests({
		vscodeExecutablePath,
		extensionDevelopmentPath: ext,
		extensionTestsPath: path.join(__dirname, 'index.js'),
		launchArgs: [tree, '--extensions-dir', extensions, '--disable-workspace-trust', '--user-data-dir', path.join(work, 'user'),
			'--no-sandbox', '--disable-gpu', '--disable-updates', '--skip-welcome', '--skip-release-notes'],
		extensionTestsEnv: {
			KWB_TREE: tree,
			KWB_RESULTS: results,
			KWB_E2E: process.env.KWB_E2E || '',
			KWB_ONLY: process.env.KWB_ONLY || '',
			KWB_GREP: process.env.KWB_GREP || '',
			...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
		},
	});
	if (!process.env.KWB_KEEP)
		fs.rmSync(work, { recursive: true, force: true });
}

main().catch(e => {
	console.error(e.message || e);
	process.exit(1);
});

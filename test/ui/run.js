'use strict';

// Click-through UI tests: vscode-extension-tester drives a real VS Code
// window with WebDriver (clicks, right-clicks, toolbars, quick picks), on
// a throwaway clone of a kernel tree, with the packaged extension
// installed.
//
//   KWB_KERNEL_TREE  kernel source tree to clone (default ../linux-playground)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ExTester, ReleaseQuality } = require('vscode-extension-tester');

const ext = path.resolve(__dirname, '../..');
const source = path.resolve(process.env.KWB_KERNEL_TREE || path.join(ext, '../linux-playground'));

function git(cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-ui-'));
	const tree = path.join(work, 'linux');
	git(work, 'clone', '-q', '--shared', source, tree);
	git(tree, 'config', 'user.name', 'Kernel Workbench Test');
	git(tree, 'config', 'user.email', 'test@example.com');
	git(tree, 'checkout', '-q', '-B', 'kwb-test-base', 'HEAD');
	const settings = path.join(work, 'settings.json');
	fs.writeFileSync(settings, JSON.stringify({
		'security.workspace.trust.enabled': false,
		'workbench.startupEditor': 'none',
		'workbench.view.alwaysShowHeaderActions': true,
		'window.dialogStyle': 'custom',
		'extensions.autoCheckUpdates': false,
		'update.mode': 'none',
	}));
	process.env.KWB_TREE = tree;

	// Downloads (VS Code, ChromeDriver) are kept between runs.
	const storage = path.join(ext, '.vscode-test', 'extest');
	const tester = new ExTester(storage, ReleaseQuality.Stable, path.join(work, 'extensions'));
	const code = await tester.setupAndRunTests(path.join(__dirname, '*.ui.test.js'), process.env.KWB_VSCODE_VERSION || 'latest',
		{ installDependencies: false },
		{ resources: [tree], settings, config: path.join(__dirname, '.mocharc.json'), offline: false, cleanup: true });
	if (!process.env.KWB_KEEP)
		fs.rmSync(work, { recursive: true, force: true });
	process.exit(code);
}

main().catch(e => {
	console.error(e.stack || e);
	process.exit(1);
});

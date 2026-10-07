// @ts-check
'use strict';

const crypto = require('crypto');

/**
 * The page shell shared by the extension's webview views: theme-aware
 * styles, a strict Content-Security-Policy, and a small client prelude.
 *
 * The prelude defines `vscode` (the webview API), `$` (getElementById),
 * `esc` (HTML-escape) and wires every element with a data-cmd attribute
 * to post { type: 'command', command, arg } on click, where arg is the
 * element's data-arg, if any.
 */

const STYLE = `
	body { padding: 4px 12px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
	h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 16px 0 6px; font-weight: 600; }
	label { display: block; margin: 8px 0 3px; color: var(--vscode-descriptionForeground); }
	label.check { display: flex; align-items: center; gap: 6px; color: var(--vscode-foreground); }
	label.check input { width: auto; }
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
	.missing, .error { color: var(--vscode-errorForeground); }
	.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
	.ok { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
	.list { margin: 4px 0; padding: 0; list-style: none; }
	.list li { display: flex; gap: 6px; align-items: baseline; padding: 2px 0; cursor: pointer; }
	.list li:hover { background: var(--vscode-list-hoverBackground); }
	.list .mono, .mono { font-family: var(--vscode-editor-font-family); }
	.list .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	pre.out { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: 11px;
		background: var(--vscode-textCodeBlock-background); padding: 6px; max-height: 18em; overflow: auto; }
	a { color: var(--vscode-textLink-foreground); cursor: pointer; }
`;

const PRELUDE = `
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);
	const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	document.addEventListener('click', e => {
		const el = e.target instanceof Element ? e.target.closest('[data-cmd]') : null;
		if (el && !el.disabled)
			vscode.postMessage({ type: 'command', command: el.dataset.cmd, arg: el.dataset.arg });
	});
`;

/**
 * @param {string} body   HTML of the page body
 * @param {string} script client script, run after the prelude
 */
function page(body, script) {
	const nonce = crypto.randomBytes(16).toString('base64');
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLE}</style></head>
<body>
${body}
<script nonce="${nonce}">${PRELUDE}
${script}
</script>
</body></html>`;
}

module.exports = { page };

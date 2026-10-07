// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { gitStatus } = require('./git');

/** @typedef {import('./patches').Patches} Patches */

/**
 * One mail as reported by git send-email --dry-run.
 * @typedef {{ subject: string, recipients: string[] }} DryMail
 */

/**
 * Sending a generated series with git send-email: always a dry run
 * first; the real send is only offered for exactly the files that dry
 * run covered, after one confirmation, in a terminal (SMTP may ask for
 * a password).
 */
class Sender {
	/** @param {Patches} patches */
	constructor(patches) {
		this.patches = patches;
		this.root = patches.root;
		/** @type {{ fingerprint: string, mails: DryMail[], ok: boolean } | undefined} */
		this.dry = undefined;
		this.smtp = '';
	}

	/** Files of the last generated series, in order. */
	files() {
		const o = this.patches.output;
		return o ? o.files.map(f => path.join(o.dir, f)).filter(f => fs.existsSync(f)) : [];
	}

	/** Changes when any file is regenerated or edited. @param {string[]} files */
	fingerprint(files) {
		return files.map(f => `${f}:${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}`).join('|');
	}

	/** A one-line account of the SMTP setup, from git config (read only). */
	async checkConfig() {
		const get = async (/** @type {string} */ k) => (await gitStatus(this.root, ['config', '--get', k])).stdout.trim();
		const server = await get('sendemail.smtpServer');
		const user = await get('sendemail.smtpUser');
		const port = await get('sendemail.smtpServerPort');
		const enc = await get('sendemail.smtpEncryption');
		this.smtp = server
			? `${user ? user + ' @ ' : ''}${server}${port ? ':' + port : ''}${enc ? ' (' + enc + ')' : ''}`
			: 'no sendemail.smtpServer: git send-email would use the local sendmail program';
		return this.smtp;
	}

	/** git send-email --dry-run on the generated files; shows every mail. */
	async dryRun() {
		const files = this.files();
		if (!files.length)
			return vscode.window.showErrorMessage('Kernel: generate the patches first.');
		const r = await gitStatus(this.root, ['send-email', '--dry-run', '--confirm=never', '--suppress-cc=self', ...files]);
		if (/is not a git command/.test(r.stderr)) {
			this.dry = undefined;
			return vscode.window.showErrorMessage('Kernel: git send-email is not installed (Debian/Ubuntu: sudo apt install git-email).');
		}
		const mails = parseDryRun(r.stdout);
		const ok = r.code === 0 && mails.length === files.length;
		this.dry = { fingerprint: this.fingerprint(files), mails, ok };
		await this.checkConfig();
		const summary = [
			`git send-email --dry-run: ${ok ? 'OK' : 'FAILED'}, ${mails.length} of ${files.length} mails`,
			`SMTP: ${this.smtp}`,
			'',
			...mails.map((m, i) => `${i + 1}. ${m.subject}\n   to ${m.recipients.length}: ${m.recipients.join(', ')}`),
			'',
			'----- full output -----',
			r.stdout,
			r.stderr,
		].join('\n');
		const doc = await vscode.workspace.openTextDocument({ content: summary, language: 'plaintext' });
		await vscode.window.showTextDocument(doc, { preview: true });
		this.patches.series.changed();
	}

	/** Whether the last dry run covers exactly the current files. */
	dryRunCurrent() {
		const files = this.files();
		return !!(this.dry?.ok && files.length && this.dry.fingerprint === this.fingerprint(files));
	}

	/** Send for real, after a confirmation, in a terminal. */
	async send() {
		const files = this.files();
		if (!this.dryRunCurrent())
			return vscode.window.showErrorMessage('Kernel: run a dry run of these exact files first.');
		const dry = /** @type {NonNullable<Sender['dry']>} */ (this.dry);
		const everyone = new Set(dry.mails.flatMap(m => m.recipients));
		const pick = await vscode.window.showWarningMessage(
			`Send ${files.length} mail${files.length > 1 ? 's' : ''} to ${everyone.size} address${everyone.size > 1 ? 'es' : ''}?`,
			{ modal: true, detail: `${dry.mails[0]?.subject || ''}\nvia ${this.smtp}\n\nSent mail cannot be taken back.` }, 'Send');
		if (pick !== 'Send')
			return;
		const term = vscode.window.createTerminal({
			name: 'git send-email',
			cwd: this.root,
			shellPath: 'git',
			shellArgs: ['send-email', '--confirm=never', '--suppress-cc=self', ...files],
		});
		term.show();
		this.dry = undefined; // a new send needs a new dry run
		this.patches.series.changed();
	}
}

/**
 * The mails in git send-email --dry-run output: each "Dry-OK" block's
 * RCPT TO recipients and Subject.
 * @param {string} out
 * @returns {DryMail[]}
 */
function parseDryRun(out) {
	return out.split(/^Dry-OK\. Log says:$/m).slice(1).map(block => ({
		subject: (/^Subject: (.*)$/m.exec(block)?.[1] || '').trim(),
		recipients: [...block.matchAll(/^RCPT TO:<([^>]+)>$/gm)].map(m => m[1]),
	}));
}

module.exports = { Sender, parseDryRun };

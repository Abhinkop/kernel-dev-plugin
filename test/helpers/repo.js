'use strict';

// Throwaway git repositories for tests.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com',
	GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com',
	GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir(),
};

class Repo {
	constructor(dir) {
		this.dir = dir;
	}

	/** @param {string[]} args */
	git(...args) {
		return execFileSync('git', args, { cwd: this.dir, env: ENV, encoding: 'utf8' });
	}

	write(file, text) {
		const p = path.join(this.dir, file);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, text);
	}

	read(file) {
		return fs.readFileSync(path.join(this.dir, file), 'utf8');
	}

	/** Write files and commit them; returns the new commit's hash. */
	commit(message, files = {}, date) {
		for (const [f, t] of Object.entries(files))
			if (t === null) fs.rmSync(path.join(this.dir, f)); else this.write(f, t);
		this.git('add', '-A');
		const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
		execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: this.dir, env: { ...ENV, ...env } });
		return this.git('rev-parse', 'HEAD').trim();
	}

	remove() {
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}

/** A new repository with Kbuild and Kconfig, so it looks like a kernel tree. */
function makeRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-test-'));
	const repo = new Repo(dir);
	repo.git('init', '-q', '-b', 'master');
	repo.git('config', 'user.name', 'Test Author');
	repo.git('config', 'user.email', 'author@example.com');
	repo.commit('Initial', { Kbuild: 'obj-y += kernel/\n', Kconfig: 'mainmenu "Test"\n' });
	return repo;
}

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-tmp-'));
}

module.exports = { Repo, makeRepo, tempDir, ENV };

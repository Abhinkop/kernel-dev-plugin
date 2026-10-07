'use strict';

// Mocha runner inside the VS Code extension host. Also writes the UI
// timings the tests record into test-results/ui-performance.{json,md}.

const fs = require('fs');
const path = require('path');
const Mocha = require('mocha');

exports.run = function () {
	const mocha = new Mocha({ ui: 'bdd', timeout: 120000, color: false, reporter: 'spec' });
	for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort())
		mocha.addFile(path.join(__dirname, f));
	return new Promise((resolve, reject) => {
		mocha.run(failures => {
			const perf = require('./perf');
			perf.write(process.env.KWB_RESULTS);
			if (failures)
				reject(new Error(`${failures} integration test${failures > 1 ? 's' : ''} failed`));
			else
				resolve();
		});
	});
};

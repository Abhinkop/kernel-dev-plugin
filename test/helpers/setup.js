'use strict';

// Loaded by mocha (--require) before the unit tests: makes
// require('vscode') return the mock, and resets it before every test.

const Module = require('module');
const mock = require('./vscode');

const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? mock.vscode : load.call(this, request, ...rest);
};

exports.mochaHooks = {
	beforeEach() {
		mock.reset();
	},
};

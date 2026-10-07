#!/bin/bash
# Runs inside the test container (scripts/test.sh): type check, unit
# tests, integration tests in VS Code, and a combined coverage report.
#   $1: all (default) | unit | integration
set -euo pipefail
what=${1:-all}

[ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error
cov=coverage/tmp
rm -rf coverage test-results
mkdir -p "$cov" test-results

echo "== type check"
npm run -s typecheck

if [ "$what" != integration ]; then
	echo "== unit tests"
	NODE_V8_COVERAGE=$PWD/$cov npx mocha --reporter spec 2>&1 | tee test-results/unit.txt
fi

if [ "$what" != unit ]; then
	echo "== integration tests (VS Code${KWB_E2E:+, end to end})"
	# VS Code's built-in AI components log a lot when not signed in; drop that.
	NODE_V8_COVERAGE=$PWD/$cov xvfb-run -a node test/integration/run.js 2>&1 \
		| grep --line-buffered -vE '^\[(AgentHost|RemoteAgentHost|ChatModelSelection|AccountPolicyGate)\]|Unknown channel: agentHost|DeprecationWarning: .url\.parse|trace-deprecation' \
		| tee test-results/integration.txt
fi

echo "== coverage"
npx c8 report --temp-directory "$cov" --reports-dir coverage --all --include 'src/**' --include extension.js \
	--reporter text --reporter html --reporter json-summary | tee test-results/coverage.txt
node test/coverage.js coverage/coverage-summary.json > test-results/coverage.md
echo "Reports: coverage/index.html, test-results/"

#!/bin/bash
# Runs inside the test container (scripts/test.sh): type check, unit
# tests, integration tests in VS Code, and a combined coverage report.
#   $1: all (default) | unit | integration | ui
set -euo pipefail
what=${1:-all}

[ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error
cov=coverage/tmp
rm -rf coverage test-results
mkdir -p "$cov" test-results

echo "== type check"
npm run -s typecheck

if [ "$what" = all ] || [ "$what" = unit ]; then
	echo "== unit tests"
	NODE_V8_COVERAGE=$PWD/$cov npx mocha --reporter spec 2>&1 | tee test-results/unit.txt
fi

if [ "$what" = all ] || [ "$what" = integration ]; then
	echo "== integration tests (VS Code${KWB_E2E:+, end to end})"
	# VS Code's built-in AI components log a lot when not signed in; drop that.
	NODE_V8_COVERAGE=$PWD/$cov xvfb-run -a node test/integration/run.js 2>&1 \
		| grep --line-buffered -vE '^\[(AgentHost|RemoteAgentHost|ChatModelSelection|AccountPolicyGate)\]|Unknown channel: agentHost|DeprecationWarning: .url\.parse|trace-deprecation' \
		| tee test-results/integration.txt
fi

if [ "$what" = all ] || [ "$what" = ui ]; then
	echo "== UI tests (clicks in a real VS Code window)"
	xvfb-run -a -s '-screen 0 1600x1000x24' node test/ui/run.js 2>&1 | tee test-results/ui.txt
fi

[ "$what" = ui ] && exit 0
echo "== coverage"
npx c8 report --temp-directory "$cov" --reports-dir coverage --all --include 'src/**' --include extension.js \
	--reporter text --reporter html --reporter json-summary | tee test-results/coverage.txt
node test/coverage.js coverage/coverage-summary.json > test-results/coverage.md
echo "Reports: coverage/index.html, test-results/"

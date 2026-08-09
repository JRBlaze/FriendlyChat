#!/usr/bin/env node
// Friendly Chat test runner.
//
// Deliberately dependency-light: one tiny runner plus jsdom. Run with
//   npm test
// or a single suite with
//   node tests/run.js youtube

const path = require('path');

const SUITES = [
  'youtube.test.js',
  'updater.test.js',
  'server.test.js',
  'render.test.js',
  'app.test.js',
  'perf.test.js',
];

const state = { passed: 0, failed: 0, failures: [], current: null };

const registry = [];

function describe(name, fn) {
  registry.push({ name, fn });
}

const pending = [];
function it(name, fn) {
  pending.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || 'values differ'}\n    expected: ${e}\n    actual:   ${a}`);
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || 'missing substring'}\n    expected to contain: ${needle}\n    actual: ${String(haystack).slice(0, 400)}`);
  }
}

function assertNotIncludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) {
    throw new Error(`${message || 'unexpected substring'}\n    expected NOT to contain: ${needle}\n    actual: ${String(haystack).slice(0, 400)}`);
  }
}

async function assertRejects(fn, message) {
  try {
    await fn();
  } catch (_) {
    return;
  }
  throw new Error(message || 'expected the call to fail');
}

global.describe = describe;
global.it = it;
global.assert = assert;
global.assertEqual = assertEqual;
global.assertIncludes = assertIncludes;
global.assertNotIncludes = assertNotIncludes;
global.assertRejects = assertRejects;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

async function main() {
  const filter = process.argv[2];
  const suites = filter ? SUITES.filter(s => s.includes(filter)) : SUITES;
  if (!suites.length) {
    console.error(`No suite matches "${filter}". Available: ${SUITES.join(', ')}`);
    process.exit(1);
  }

  const started = Date.now();

  for (const suite of suites) {
    registry.length = 0;
    require(path.join(__dirname, suite));

    for (const group of registry) {
      pending.length = 0;
      group.fn();
      console.log(`\n${BOLD}${group.name}${RESET}`);
      for (const test of pending) {
        const testStarted = Date.now();
        try {
          await test.fn();
          const ms = Date.now() - testStarted;
          state.passed++;
          console.log(`  ${GREEN}✓${RESET} ${test.name} ${DIM}(${ms}ms)${RESET}`);
        } catch (err) {
          state.failed++;
          state.failures.push({ suite: group.name, test: test.name, err });
          console.log(`  ${RED}✗${RESET} ${test.name}`);
          console.log(`      ${RED}${String(err.message).split('\n').join('\n      ')}${RESET}`);
        }
      }
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${BOLD}${state.passed} passed, ${state.failed} failed${RESET} ${DIM}in ${elapsed}s${RESET}`);

  if (state.failed) {
    console.log(`\n${RED}Failures:${RESET}`);
    state.failures.forEach(f => {
      console.log(`  ${f.suite} › ${f.test}`);
      if (f.err.stack) console.log(`${DIM}${f.err.stack.split('\n').slice(1, 4).join('\n')}${RESET}`);
    });
  }

  process.exit(state.failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

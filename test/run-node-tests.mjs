// Runs the Node suite under the built-in test runner with two reporters (spec on
// stdout, JUnit at test-results/junit.xml for CI) and enforces a case-count
// floor, so a refactor that silently stops registering tests fails the gate.
//
// Run locally: `npm test`. Raise TEST_CASE_FLOOR when tests are added; never
// lower it without saying why in the commit message.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_CASE_FLOOR = 549;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT_DIR = resolve(ROOT, 'test-results');
const JUNIT = resolve(REPORT_DIR, 'junit.xml');

/** Count cases and failures in a JUnit document produced by node:test. */
export function countJUnitCases(xml) {
  const cases = (xml.match(/<testcase\b/g) || []).length;
  const failures = (xml.match(/<(?:failure|error)\b/g) || []).length;
  return { cases, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=junit',
      `--test-reporter-destination=${JUNIT}`,
      'test/*.test.mjs',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`node --test was terminated by ${signal}`);
      process.exit(1);
    }
    let report;
    try {
      report = countJUnitCases(readFileSync(JUNIT, 'utf8'));
    } catch (error) {
      console.error(`Test floor: could not read ${JUNIT}: ${error.message}`);
      process.exit(code || 1);
    }
    console.log(`\nJUnit: ${report.cases} cases, ${report.failures} failed → ${JUNIT}`);
    if (code !== 0) process.exit(code);
    if (report.cases < TEST_CASE_FLOOR) {
      console.error(
        `Test floor: ${report.cases} cases is below the floor of ${TEST_CASE_FLOOR} ` +
          '(TEST_CASE_FLOOR in test/run-node-tests.mjs). Tests were removed or stopped registering.',
      );
      process.exit(1);
    }
    process.exit(0);
  });
}

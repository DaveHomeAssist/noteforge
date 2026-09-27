// `tsc --noEmit --checkJs` gate (jsconfig.json covers src/core and src/utils)
// with a per-file ratchet stored in test/typecheck-baseline.json.
//
// A file may never carry more errors than its baseline entry; files not listed
// start at zero. When a file's count drops, run `npm run typecheck -- --update`
// and commit the lowered baseline so the count can only go down. Fixing every
// error in a file and then keeping it clean is the intended path; JSDoc
// `@typedef`s for core/ and utils/ come with the Phase 0 exit criteria.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = resolve(ROOT, 'test/typecheck-baseline.json');
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc');

/** Group `file(line,col): error TSxxxx: …` lines by file. */
export function parseTscErrors(output) {
  const perFile = new Map();
  const lines = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\(\d+,\d+\): error TS\d+: /.exec(line);
    if (!match) continue;
    const file = match[1].replaceAll('\\', '/');
    perFile.set(file, (perFile.get(file) || 0) + 1);
    lines.push(line);
  }
  return { perFile, lines };
}

/** Compare per-file counts to the committed baseline. */
export function compareToBaseline(perFile, baseline) {
  const regressions = [];
  const improvements = [];
  for (const [file, count] of perFile) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) regressions.push({ file, count, allowed });
    else if (count < allowed) improvements.push({ file, count, allowed });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (allowed > 0 && !perFile.has(file)) improvements.push({ file, count: 0, allowed });
  }
  return { regressions, improvements };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes('--update');
  const result = spawnSync(process.execPath, [TSC, '-p', 'jsconfig.json', '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const { perFile, lines } = parseTscErrors(output);
  if (result.status !== 0 && lines.length === 0) {
    // tsc failed without reporting file errors (bad config, crash): never pass silently.
    console.error(output.trim());
    process.exit(result.status || 1);
  }
  let baseline = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files || {};
  } catch {
    /* first run */
  }
  const files = Object.fromEntries([...perFile].sort(([a], [b]) => a.localeCompare(b)));
  const baselineTotal = Object.values(baseline).reduce((sum, n) => sum + n, 0);

  if (update) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          $comment:
            'Per-file tsc --checkJs error ceiling; lower it with `npm run typecheck -- --update`, never raise it by hand.',
          total: lines.length,
          files,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Typecheck baseline written: ${lines.length} errors across ${perFile.size} files → ${BASELINE_PATH}`);
    process.exit(0);
  }

  const { regressions, improvements } = compareToBaseline(perFile, baseline);
  console.log(`Typecheck: ${lines.length} errors (baseline ${baselineTotal}) across ${perFile.size} files`);
  if (regressions.length) {
    for (const { file, count, allowed } of regressions) {
      console.error(`\n${file}: ${count} errors, baseline allows ${allowed}`);
      for (const line of lines) if (line.startsWith(file)) console.error(`  ${line}`);
    }
    console.error(
      '\nTypecheck ratchet: new type errors. Fix them, or explain a deliberate baseline change in the commit.',
    );
    process.exit(1);
  }
  if (improvements.length) {
    console.log(
      `Typecheck ratchet: ${improvements.length} file(s) improved; run \`npm run typecheck -- --update\` and commit test/typecheck-baseline.json.`,
    );
  }
  process.exit(0);
}

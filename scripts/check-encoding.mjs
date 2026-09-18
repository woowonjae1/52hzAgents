#!/usr/bin/env node
/*
  Refuse to commit newly mangled non-ASCII text.

  On 2026-08-28 a bulk find-and-replace (commit 2333d44, 56 files) was written
  back through a non-UTF-8 codepage. Every multi-byte character it touched
  lost its trailing bytes: 546 damaged sequences across 28 files in
  packages/wwj. The characters are gone -- 305 were recovered from git
  history, the rest are unrecoverable, and some of them landed inside regex
  character classes and template literals where they change behaviour rather
  than spelling.

  So the point of this hook is not to find damage. It is to make sure the
  same bulk-rewrite mistake cannot be made twice, because the next one may
  not have 63% of clean history to recover from.

  IT ONLY LOOKS AT ADDED LINES. The damage still on disk is not this commit's
  fault and must not block it; text this commit introduces is.

  Usage:
    node scripts/check-encoding.mjs            # staged additions (hook mode)
    node scripts/check-encoding.mjs --all      # every tracked file
*/
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/*
  A UTF-8 lead byte whose continuation bytes were shot off and replaced with
  '?', or a literal U+FFFD. Both are what a lossy re-encode leaves behind.
*/
const DAMAGE = /[\xc2-\xf4][\x80-\xbf]*\?|\xef\xbf\xbd/;
const DAMAGE_G = new RegExp(DAMAGE.source, 'g');

function git(args) {
  return execFileSync('git', args, { maxBuffer: 1 << 28 });
}

function scanAll() {
  const files = git(['ls-files', '-z']).toString('latin1').split('\0').filter(Boolean);
  const hits = [];
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    const n = (buf.toString('latin1').match(DAMAGE_G) || []).length;
    if (n) hits.push({ file, n });
  }
  return hits;
}

function scanStaged() {
  // -U0 so only the changed lines are in the patch at all.
  const patch = git(['diff', '--cached', '-U0', '--no-color']).toString('latin1');
  const hits = [];
  let file = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    if (DAMAGE.test(body)) {
      const shown = body.replace(DAMAGE_G, (m) => '>>>' + JSON.stringify(m).slice(1, -1) + '<<<');
      hits.push({ file, line: shown.trim().slice(0, 140) });
    }
  }
  return hits;
}

const all = process.argv.includes('--all');
const hits = all ? scanAll() : scanStaged();

if (!hits.length) {
  if (all) console.log('check-encoding: no damaged sequences in any tracked file.');
  process.exit(0);
}

if (all) {
  let total = 0;
  for (const h of hits) {
    console.log('  ' + String(h.n).padStart(4) + '  ' + h.file);
    total += h.n;
  }
  console.log('\ncheck-encoding: ' + total + ' damaged sequences across ' + hits.length + ' files.');
  process.exit(1);
}

console.error('\ncheck-encoding: this commit ADDS mangled non-ASCII text.\n');
for (const h of hits.slice(0, 20)) {
  console.error('  ' + h.file);
  console.error('    ' + h.line);
}
if (hits.length > 20) console.error('  ... and ' + (hits.length - 20) + ' more');
console.error([
  '',
  'A multi-byte character lost its trailing bytes. That happens when a file is',
  'read as UTF-8 and written back through a system codepage -- in PowerShell,',
  'piping Get-Content into Set-Content does exactly this. Use an explicit UTF-8',
  'encoder ([System.IO.File]::WriteAllText with [System.Text.UTF8Encoding]), or',
  'make the edit in a tool that round-trips UTF-8.',
  '',
  'The characters cannot be recovered afterwards. Fix the file, then commit.',
  '',
].join('\n'));
process.exit(1);

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));

test('commitlint accepts GitHub squash messages without weakening ordinary commit checks', () => {
  const cli = fileURLToPath(new URL('../node_modules/@commitlint/cli/cli.js', import.meta.url));
  const lint = (input) => spawnSync(process.execPath, [cli], { input, encoding: 'utf8' });

  assert.equal(lint('Align commitlint footer and body line limits (#7)\n\n* Initial plan\n\n* fix: allow long commit footer line\n').status, 0);
  assert.notEqual(lint('Align commitlint footer and body line limits (#7)\n').status, 0);
  assert.notEqual(lint('Initial plan\n').status, 0);
  assert.equal(lint('fix: allow long commit footer line\n').status, 0);
  assert.equal(lint('feat: LCD-style top bar with SAVE / SAVE AS and LCD logo\n').status, 0);
  assert.notEqual(lint('fix: ALL UPPERCASE SUBJECT\n').status, 0);
  assert.notEqual(lint('fix: ' + 'x'.repeat(150) + ' (#7)\n\n* Initial plan\n').status, 0);
});

test('release builds generate the native graph after clearing the build cache', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const clear = workflow.indexOf('run: rm -rf native/build');
  const generate = workflow.indexOf('run: node scripts/build-native-graph.mjs');
  const configure = workflow.indexOf('run: cmake -B native/build');
  assert.ok(clear >= 0 && generate > clear && configure > generate);
});

test('release metadata check rejects inconsistent versions and package names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'layerforge-release-test-'));
  const files = ['package.json', 'package-lock.json', '.release-please-manifest.json'];
  const write = (file, value) => writeFileSync(join(directory, file), JSON.stringify(value));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
  try {
    write(files[0], { name: 'layerforge-vst3', version: '1.0.0' });
    write(files[1], {
      name: 'layerforge-vst3', version: '1.0.0',
      packages: { '': { name: 'layerforge-vst3', version: '1.0.0' } }
    });
    write(files[2], { '.': '1.0.0' });
    assert.equal(run().status, 0);
    assert.equal(run('--tag', 'v1.0.0').status, 0);
    const badTag = run('--tag', 'v0.3.0');
    assert.notEqual(badTag.status, 0);
    assert.match(badTag.stderr, /Release tag v0\.3\.0 does not match package\.json version/);
    assert.notEqual(run('--tag').status, 0);

    write(files[2], { '.': '0.2.0' });
    const badVersion = run();
    assert.notEqual(badVersion.status, 0);
    assert.match(badVersion.stderr, /does not match package\.json version/);

    write(files[2], { '.': '1.0.0' });
    write(files[1], {
      name: 'layerforge-vst3', version: '1.0.0',
      packages: { '': { name: 'layerforge-vst3', version: '0.2.0' } }
    });
    assert.notEqual(run().status, 0);

    write(files[1], {
      name: 'wrong-name', version: '1.0.0',
      packages: { '': { name: 'layerforge-vst3', version: '1.0.0' } }
    });
    const badName = run();
    assert.notEqual(badName.status, 0);
    assert.match(badName.stderr, /package name does not match/);
  } finally {
    for (const file of files) unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
});

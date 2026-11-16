import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));

test('release metadata check rejects inconsistent versions and package names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'layerforge-release-test-'));
  const files = ['package.json', 'package-lock.json', '.release-please-manifest.json'];
  const write = (file, value) => writeFileSync(join(directory, file), JSON.stringify(value));
  const run = () => spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
  try {
    write(files[0], { name: 'layerforge-vst3', version: '0.1.0' });
    write(files[1], {
      name: 'layerforge-vst3', version: '0.1.0',
      packages: { '': { name: 'layerforge-vst3', version: '0.1.0' } }
    });
    write(files[2], { '.': '0.1.0' });
    assert.equal(run().status, 0);

    write(files[2], { '.': '0.2.0' });
    const badVersion = run();
    assert.notEqual(badVersion.status, 0);
    assert.match(badVersion.stderr, /does not match package\.json version/);

    write(files[2], { '.': '0.1.0' });
    write(files[1], {
      name: 'layerforge-vst3', version: '0.1.0',
      packages: { '': { name: 'layerforge-vst3', version: '0.2.0' } }
    });
    assert.notEqual(run().status, 0);

    write(files[1], {
      name: 'wrong-name', version: '0.1.0',
      packages: { '': { name: 'layerforge-vst3', version: '0.1.0' } }
    });
    const badName = run();
    assert.notEqual(badName.status, 0);
    assert.match(badName.stderr, /package name does not match/);
  } finally {
    for (const file of files) unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
});

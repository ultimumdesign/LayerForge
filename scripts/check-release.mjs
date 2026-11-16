import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJson('.release-please-manifest.json');
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');

if (typeof pkg.name !== 'string' || !pkg.name) {
  throw new Error('package.json must specify a package name');
}
if (typeof pkg.version !== 'string' || !pkg.version) {
  throw new Error('package.json must specify a release version');
}
for (const [source, version] of [
  ['package-lock.json', lock.version],
  ['package-lock.json root package', lock.packages?.['']?.version],
  ['.release-please-manifest.json', manifest['.']]
]) {
  if (version !== pkg.version) {
    throw new Error(`${source} version ${version} does not match package.json version ${pkg.version}`);
  }
}
if (pkg.name !== lock.name || pkg.name !== lock.packages?.['']?.name) {
  throw new Error('package-lock.json package name does not match package.json');
}

console.log(`Release metadata is consistent: ${pkg.name} ${pkg.version}`);

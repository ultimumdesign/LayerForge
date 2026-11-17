import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const acceptedAdvisory = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const severities = new Set(['info', 'low', 'moderate', 'high', 'critical']);

export function checkAudit(report, status) {
  if ((status !== 0 && status !== 1) || report?.error || report?.auditReportVersion !== 2 ||
      !report.vulnerabilities || typeof report.vulnerabilities !== 'object' ||
      Array.isArray(report.vulnerabilities)) {
    throw new Error('npm audit failed or returned an invalid report');
  }
  const vulnerabilities = report.vulnerabilities;
  const entries = Object.entries(vulnerabilities);
  if (entries.some(([name, item]) =>
    !item || item.name !== name || !severities.has(item.severity) || !Array.isArray(item.via))) {
    throw new Error('npm audit returned an invalid vulnerability');
  }
  const relevant = entries.filter(([, item]) => item.severity === 'high' || item.severity === 'critical');
  if ((status === 0) !== (relevant.length === 0)) {
    throw new Error('npm audit exit status does not match the report');
  }

  const isAccepted = (name, visiting = new Set()) => {
    const item = vulnerabilities[name];
    if (!item || visiting.has(name) || item.via.length === 0) return false;
    const next = new Set(visiting).add(name);
    return item.via.every((cause) => {
      if (typeof cause === 'string') return isAccepted(cause, next);
      return cause && typeof cause === 'object' && cause.name === 'picomatch' &&
        cause.dependency === 'picomatch' && cause.url === acceptedAdvisory;
    });
  };
  const unexpected = relevant.filter(([name]) => !isAccepted(name)).map(([name]) => name);
  if (unexpected.length) {
    throw new Error(`Unaccepted high or critical npm vulnerabilities: ${unexpected.join(', ')}`);
  }
  return relevant.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , path, status] = process.argv;
  if (!path || !['0', '1'].includes(status) || process.argv.length !== 4) {
    throw new Error('Usage: node scripts/check-audit.mjs <report.json> <audit-exit-status>');
  }
  const count = checkAudit(JSON.parse(readFileSync(path, 'utf8')), Number(status));
  if (count) {
    console.warn(`Temporarily accepting ${acceptedAdvisory} and ${count - 1} related findings.`);
  } else {
    console.log('No high or critical npm vulnerabilities reported.');
  }
}

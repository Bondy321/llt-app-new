'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyPatches } = require('./dependencyPatches');
const manifest = require('./patchManifest.json');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function parseAudit(output, status, error) {
  if (error || ![0, 1].includes(status)) throw new Error('npm audit failed to complete');
  let audit;
  try { audit = JSON.parse(output); } catch { throw new Error('npm audit returned invalid JSON'); }
  if (audit.error || audit.auditReportVersion !== 2 || !audit.vulnerabilities || typeof audit.vulnerabilities !== 'object' || Array.isArray(audit.vulnerabilities) || !audit.metadata?.vulnerabilities) {
    throw new Error('npm audit returned an unsupported or incomplete report');
  }
  for (const [name, finding] of Object.entries(audit.vulnerabilities)) {
    if (finding.name !== name || !['info', 'low', 'moderate', 'high', 'critical'].includes(finding.severity) || !Array.isArray(finding.via) || !finding.via.length || !Array.isArray(finding.nodes) || !finding.nodes.length || finding.nodes.some(node => typeof node !== 'string')) throw new Error('Invalid npm vulnerability record');
    for (const via of finding.via) {
      if (typeof via === 'string' && via.length > 0) continue;
      if (!via || typeof via !== 'object' || Array.isArray(via)
        || !Number.isInteger(via.source) || via.source <= 0
        || ['name', 'dependency', 'title', 'range'].some(key => typeof via[key] !== 'string' || !via[key])
        || typeof via.url !== 'string' || !via.url.startsWith('https://')
        || !['info', 'low', 'moderate', 'high', 'critical'].includes(via.severity)) {
        throw new Error('Invalid npm direct advisory record');
      }
    }
  }
  const counts = audit.metadata.vulnerabilities;
  if (['info', 'low', 'moderate', 'high', 'critical', 'total'].some(key => !Number.isInteger(counts[key]) || counts[key] < 0) || counts.total !== Object.keys(audit.vulnerabilities).length || counts.total !== counts.info + counts.low + counts.moderate + counts.high + counts.critical) throw new Error('Inconsistent npm audit counts');
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    if (counts[severity] !== Object.values(audit.vulnerabilities).filter(finding => finding.severity === severity).length) throw new Error('Inconsistent npm audit severity counts');
  }
  if (status !== (counts.total > counts.info ? 1 : 0)) throw new Error('npm audit exit status contradicts its report');
  return audit;
}

function evaluateAudit(audit, installed, policy = manifest) {
  const severities = ['none', 'info', 'low', 'moderate', 'high', 'critical'];
  const nodes = new Map();
  for (const [name, finding] of Object.entries(audit.vulnerabilities)) {
    const references = finding.via.filter(via => typeof via === 'string');
    const direct = finding.via.filter(via => typeof via !== 'string');
    const verifiedDirect = direct.map(via => {
      if (!via || typeof via !== 'object') return false;
      const entry = policy.patches.find(item => item.package === name && item.advisory === via.url?.split('/').at(-1));
      if (!entry || !entry.auditRecord || canonical(via) !== canonical(entry.auditRecord)) return false;
      return finding.nodes.every(location => installed.some(copy => copy.location === location && copy.package === name && copy.version === entry.version && copy.advisory === entry.advisory));
    });
    const remainingDirect = direct.reduce((maximum, via, index) => verifiedDirect[index]
      ? maximum
      : Math.max(maximum, severities.indexOf(via?.severity) > 0 ? severities.indexOf(via.severity) : severities.indexOf(finding.severity)), 0);
    nodes.set(name, {
      references,
      anchored: direct.length > 0,
      residual: direct.length > 0 && !references.length && remainingDirect > 0
        ? Math.max(remainingDirect, severities.indexOf(finding.severity))
        : remainingDirect,
      reported: severities.indexOf(finding.severity),
    });
  }
  // Metro legitimately has circular propagated findings. A cycle is only
  // anchored when it reaches a real direct advisory. An isolated cycle or
  // missing node keeps its reported severity and cannot attest itself.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.values()) {
      if (!node.anchored && node.references.some(reference => nodes.get(reference)?.anchored)) {
        node.anchored = true;
        changed = true;
      }
    }
  }
  for (const node of nodes.values()) {
    if (!node.anchored || node.references.some(reference => !nodes.has(reference))) {
      node.residual = Math.max(node.residual, node.reported);
    }
  }
  // Recalculate inherited severity from the unmitigated direct advisories.
  // A patched high advisory plus an unpatched moderate advisory must remain
  // visible as moderate, rather than retaining the now-fixed high label.
  changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.values()) {
      const residual = Math.max(node.residual, ...node.references.map(reference => nodes.get(reference)?.residual ?? node.reported));
      if (residual !== node.residual) { node.residual = residual; changed = true; }
    }
  }
  const mitigated = [], unresolved = [];
  for (const [name, finding] of Object.entries(audit.vulnerabilities)) {
    const residual = nodes.get(name).residual;
    (residual === 0 ? mitigated : unresolved).push({
      name, severity: residual === 0 ? finding.severity : severities[residual], reportedSeverity: finding.severity,
    });
  }
  const blockers = unresolved.filter(item => ['high', 'critical'].includes(item.severity));
  return { mitigated, unresolved, blockers };
}

function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const candidate = candidates.find(file => file && fs.existsSync(file) && file.endsWith('npm-cli.js'));
  if (!candidate) throw new Error('Run this audit through the npm security script so npm_execpath is available');
  return candidate;
}

function runAudit(root, omitDev = false) {
  const installed = applyPatches(root, true);
  const result = spawnSync(process.execPath, [npmCli(), 'audit', '--json', '--ignore-scripts', '--audit-level=low', ...(omitDev ? ['--omit=dev'] : [])], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const audit = parseAudit(result.stdout, result.status, result.error);
  return { raw: audit.metadata.vulnerabilities, ...evaluateAudit(audit, installed) };
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '../..');
    // Regression proofs run on the actual installed code before mitigations
    // influence release decisions; these are bounded isolated subprocesses.
    const proof = spawnSync(process.execPath, ['--test', path.join(root, 'tests/security/dependencyBehavior.test.js')], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    if (proof.status !== 0 || proof.error) throw new Error(`Security patch regression proof failed\n${proof.stdout || ''}${proof.stderr || ''}`);
    for (const relative of ['.', 'functions', 'web-admin']) {
      const result = runAudit(path.join(root, relative), process.argv.includes('--omit=dev'));
      console.log(`${relative}: raw npm findings ${JSON.stringify(result.raw)}; verified mitigated records ${result.mitigated.length}; unresolved records ${result.unresolved.length}.`);
      for (const finding of result.unresolved) console.log(`  unresolved ${finding.severity}: ${finding.name}${finding.reportedSeverity !== finding.severity ? ` (raw inherited severity: ${finding.reportedSeverity})` : ''}`);
      if (result.blockers.length) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { evaluateAudit, parseAudit, runAudit };

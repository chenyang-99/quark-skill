'use strict';
const fs = require('node:fs');
const { runCli, writeJson } = require('./task.cjs');
const TARGETS = {
  windows: /-win\.exe$/i,
  'mac-intel': /-mac_x64\.dmg$/i,
  'mac-apple': /-mac_arm64\.dmg$/i
};
async function verifyRelease(input) {
  const targets = input.targets;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 3 ||
      new Set(targets).size !== targets.length ||
      targets.some((v) => typeof v !== 'string' || !Object.hasOwn(TARGETS, v))) {
    throw new Error('Invalid release verification targets.');
  }
  const response = await fetch('https://api.github.com/repos/arcsin1/oh-my-ppt/releases/latest',
    { headers: { 'User-Agent': 'quark-skill-release-check' },
      signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Cannot read latest GitHub release metadata.');
  const release = await response.json();
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name || '') || release.draft ||
      release.prerelease || !Array.isArray(release.assets)) {
    throw new Error('Invalid latest stable release metadata.');
  }
  const files = [];
  for (const target of targets) {
    const assets = release.assets.filter((a) => TARGETS[target].test(a.name || '') &&
      a.name.includes(release.tag_name.slice(1)));
    if (assets.length !== 1) throw new Error('Expected exactly one asset for ' + target);
    const asset = assets[0];
    const results = runCli(['search', '--keyword', asset.name, '--stdout-only'],
      '只读核验用户网盘中的 Oh My PPT 官方安装包',
      { timeoutMs: 120000 });
    const row = results.rows.findLast((r) =>
      r.type === 'artifact' && r.action === 'search' && r.data?.file_path);
    if (!row) throw new Error('Official Quark search artifact was missing.');
    const matches = fs.readFileSync(row.data.file_path, 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      .filter((item) => item.filename === asset.name && Number(item.size) === asset.size);
    files.push({ name: asset.name, bytes: asset.size, verified: matches.length > 0,
      matching_count: matches.length, target });
  }
  const manifest = {
    status: 'complete', operation: 'verify-release', version: release.tag_name,
    files, verified_count: files.filter((f) => f.verified).length
  };
  writeJson('manifest.json', manifest);
  return manifest;
}
module.exports = { verifyRelease };

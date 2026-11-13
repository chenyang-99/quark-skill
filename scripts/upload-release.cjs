'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { runCli, writeJson } = require('./task.cjs');

const TARGETS = {
  windows: /-win\.exe$/i,
  'mac-intel': /-mac_x64\.dmg$/i,
  'mac-apple': /-mac_arm64\.dmg$/i
};
const MAX_BYTES = 850 * 1024 * 1024;
const MAX_TOTAL = 1700 * 1024 * 1024;
const RELEASE_API = 'https://api.github.com/repos/arcsin1/oh-my-ppt/releases/latest';

async function download(asset, directory) {
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      !url.pathname.startsWith('/arcsin1/oh-my-ppt/releases/download/')) {
    throw new Error('Unexpected release asset origin.');
  }
  if (!asset.name || !/^oh-my-ppt-[\w.-]+\.(exe|dmg)$/i.test(asset.name) ||
      !Number.isInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES) {
    throw new Error('Release asset has an unsafe name or size.');
  }
  const target = path.join(directory, asset.name);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'quark-skill-upload-release' },
    signal: AbortSignal.timeout(12 * 60 * 1000)
  });
  if (!response.ok || !response.body) throw new Error('GitHub asset download failed.');
  const hash = crypto.createHash('sha256');
  const stream = Readable.fromWeb(response.body);
  stream.on('data', (chunk) => hash.update(chunk));
  await pipeline(stream, fs.createWriteStream(target, { mode: 0o600 }));
  const bytes = fs.statSync(target).size;
  if (bytes !== asset.size) throw new Error('GitHub release asset size mismatch.');
  const digest = hash.digest('hex');
  if (asset.digest && asset.digest.startsWith('sha256:') &&
      digest !== asset.digest.slice(7).toLowerCase()) {
    throw new Error('GitHub release asset SHA-256 mismatch.');
  }
  return { target, filename: asset.name, bytes, sha256: digest };
}

async function uploadRelease(input) {
  const targets = input.targets;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 3 ||
      new Set(targets).size !== targets.length ||
      targets.some((v) => typeof v !== 'string' || !Object.hasOwn(TARGETS, v))) {
    throw new Error('Invalid or duplicate release targets.');
  }
  const parent = input.parent_fid;
  if (parent != null && (typeof parent !== 'string' || !parent ||
      parent.length > 8192 || /[\x00-\x1f\x7f]/.test(parent))) {
    throw new Error('Invalid target folder identifier.');
  }
  const response = await fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json',
      'User-Agent': 'quark-skill-upload-release' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Cannot confirm latest official release.');
  const release = await response.json();
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name || '') || release.draft || release.prerelease ||
      !Array.isArray(release.assets)) {
    throw new Error('Latest GitHub release is not a verified stable release.');
  }
  const assets = targets.map((target) => {
    const matches = release.assets.filter((a) => TARGETS[target].test(a.name || '') &&
      a.name.includes(release.tag_name.slice(1)));
    if (matches.length !== 1) throw new Error('Expected exactly one installer for ' + target);
    return matches[0];
  });
  if (assets.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL) {
    throw new Error('Combined release assets exceed the upload limit.');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-release-'));
  try {
    const files = [];
    for (const asset of assets) files.push(await download(asset, directory));
    const args = ['upload', ...files.map((f) => f.target)];
    if (parent != null) args.push('--parent-fid', parent);
    const result = runCli(args, '上传用户请求的 Oh My PPT 官方安装包',
      { timeoutMs: 25 * 60 * 1000 });
    const completed = result.rows.filter((row) => row.type === 'list' && row.code === 0);
    if (completed.length < files.length) {
      throw new Error('Official CLI did not confirm all upload items.');
    }
    const manifest = {
      status: 'complete',
      operation: 'upload-release',
      repository: 'arcsin1/oh-my-ppt',
      version: release.tag_name,
      files: files.map((f) => ({ name: f.filename, bytes: f.bytes, sha256: f.sha256 })),
      uploaded_count: completed.length,
      note: 'Upload confirmed by the official Quark CLI; target folder depends on Quark authorization.'
    };
    writeJson('manifest.json', manifest);
    return manifest;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { uploadRelease };

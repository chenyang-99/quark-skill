'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_BRANCH = 'quark-state';
const STATE_FILE = 'auth-state.enc';

function stateKey(value) {
  if (!/^[0-9a-f]{64}$/i.test(value || '')) {
    throw new Error('QUARK_STATE_KEY must be a 32-byte hex key stored in GitHub Secrets.');
  }
  return Buffer.from(value, 'hex');
}

function seal(bytes, key, repository) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', stateKey(key), iv);
  cipher.setAAD(Buffer.from(repository));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') });
}

function unseal(text, key, repository) {
  const envelope = JSON.parse(text);
  if (envelope.version !== 1 || !/^[0-9a-f]{24}$/i.test(envelope.iv || '') ||
      !/^[0-9a-f]{32}$/i.test(envelope.tag || '') || typeof envelope.data !== 'string') {
    throw new Error('Invalid encrypted authorization state.');
  }
  const cipher = crypto.createDecipheriv('aes-256-gcm', stateKey(key), Buffer.from(envelope.iv, 'hex'));
  cipher.setAAD(Buffer.from(repository));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]);
}

async function api(method, endpoint, body, { allow404 = false } = {}) {
  if (!process.env.GITHUB_TOKEN) throw new Error('The workflow GitHub token is missing.');
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
      'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub state API failed (HTTP ${response.status}).`);
  return response.status === 204 ? null : response.json();
}

function configPath() {
  const skill = process.env.QUARK_SKILL_DIR || path.join(os.homedir(), '.agents/skills/quarkclouddrive');
  return path.join(skill, 'codex/config.json');
}

async function main(action) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid repository.');
  const key = process.env.QUARK_STATE_KEY;
  stateKey(key);
  const base = `/repos/${repository}`;
  const previous = await api('GET', `${base}/contents/${STATE_FILE}?ref=${STATE_BRANCH}`, undefined, { allow404: true });
  if (action === 'restore') {
    if (!previous) throw new Error('Account is not bound. Run the authorization workflow first.');
    const bytes = unseal(Buffer.from(previous.content, 'base64').toString('utf8'), key, repository);
    const target = configPath();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    console.log('Authorization state restored without displaying credential contents.');
  } else if (action === 'save') {
    const bytes = fs.readFileSync(configPath());
    if (previous && unseal(Buffer.from(previous.content, 'base64').toString('utf8'), key, repository).equals(bytes)) {
      console.log('Authorization state unchanged.');
      return;
    }
    const reference = await api('GET', `${base}/git/ref/heads/${STATE_BRANCH}`, undefined, { allow404: true });
    if (!reference) {
      if (!/^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA || '')) throw new Error('Missing workflow commit.');
      await api('POST', `${base}/git/refs`, { ref: `refs/heads/${STATE_BRANCH}`, sha: process.env.GITHUB_SHA });
    }
    await api('PUT', `${base}/contents/${STATE_FILE}`, {
      message: 'Persist encrypted Quark authorization state', branch: STATE_BRANCH,
      content: Buffer.from(seal(bytes, key, repository)).toString('base64'),
      ...(previous ? { sha: previous.sha } : {}),
    });
    console.log('Encrypted authorization state saved.');
  } else {
    throw new Error('Expected restore or save.');
  }
}

module.exports = { seal, unseal, stateKey };
if (require.main === module) main(process.argv[2]).catch(() => {
  // Never dump HTTP response bodies, configuration data or process environment.
  console.error('Authorization state operation failed. Check binding, key and repository permissions.');
  process.exitCode = 1;
});

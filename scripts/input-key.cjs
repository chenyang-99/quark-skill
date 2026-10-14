'use strict';
const crypto = require('node:crypto');
const { api, seal, unseal, ensureBranch, STATE_BRANCH, stateKey } = require('./state.cjs');
const { keyPair } = require('./crypto.cjs');

function repository() {
  const value = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(value || '')) throw new Error('Invalid repository.');
  stateKey(process.env.QUARK_STATE_KEY);
  return value;
}

async function loadInputKey() {
  const repo = repository();
  const record = await api('GET', `/repos/${repo}/contents/input-key.enc?ref=${STATE_BRANCH}`);
  return unseal(Buffer.from(record.content, 'base64').toString('utf8'),
    process.env.QUARK_STATE_KEY, `${repo}/input-key`).toString('utf8');
}

async function ensureInputKey() {
  const repo = repository(), base = `/repos/${repo}`;
  const previous = await api('GET', `${base}/contents/input-key.enc?ref=${STATE_BRANCH}`, undefined, { allow404: true });
  let privateKey;
  if (previous) privateKey = unseal(Buffer.from(previous.content, 'base64').toString('utf8'),
    process.env.QUARK_STATE_KEY, `${repo}/input-key`).toString('utf8');
  else {
    privateKey = keyPair().privateKey;
    await ensureBranch(repo);
    await api('PUT', `${base}/contents/input-key.enc`, {
      message: 'Persist encrypted request decryption key', branch: STATE_BRANCH,
      content: Buffer.from(seal(Buffer.from(privateKey), process.env.QUARK_STATE_KEY, `${repo}/input-key`)).toString('base64') });
  }
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const current = await api('GET', `${base}/contents/request-public-key.pem?ref=${STATE_BRANCH}`, undefined, { allow404: true });
  if (!current || Buffer.from(current.content, 'base64').toString('utf8') !== publicKey) {
    await api('PUT', `${base}/contents/request-public-key.pem`, {
      message: 'Publish request encryption public key', branch: STATE_BRANCH,
      content: Buffer.from(publicKey).toString('base64'), ...(current ? { sha: current.sha } : {}) });
  }
  console.log('Encrypted request receiver ready.');
}

module.exports = { loadInputKey, ensureInputKey };
if (require.main === module) ensureInputKey().catch(() => {
  console.error('Request key setup failed. Configure QUARK_STATE_KEY in repository Actions Secrets first.');
  process.exitCode = 1;
});

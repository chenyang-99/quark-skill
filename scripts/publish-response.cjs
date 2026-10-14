'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { api } = require('./state.cjs');

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const requestId = process.env.QUARK_REQUEST_ID;
  const branch = process.env.GITHUB_REF_NAME;
  if (branch !== `quark-requests/${requestId}`) throw new Error('Response branch mismatch.');
  const envelope = JSON.parse(fs.readFileSync(path.join(process.env.QUARK_ENCRYPTED_DIR, 'encrypted-result.json'), 'utf8'));
  const body = JSON.stringify({ request_id: requestId,
    status: process.env.QUARK_JOB_STATUS === 'success' ? 'complete' : 'failed',
    run_url: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    encrypted_result: envelope });
  // Stay below GitHub's file-size limit. Only ciphertext reaches the repository.
  if (Buffer.byteLength(body) > 90 * 1024 * 1024) throw new Error('Encrypted response is too large.');
  const base = `/repos/${repository}/contents/response.json`;
  const previous = await api('GET', `${base}?ref=${encodeURIComponent(branch)}`, undefined, { allow404: true });
  await api('PUT', base, { branch, message: 'Return encrypted Agent response',
    content: Buffer.from(body).toString('base64'), ...(previous ? { sha: previous.sha } : {}) });
  console.log('Encrypted response published to the request branch.');
}

main().catch(() => {
  console.error('Could not publish the encrypted response. Inspect the workflow run.');
  process.exitCode = 1;
});

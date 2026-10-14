'use strict';
const { loadInputKey } = require('./input-key.cjs');
const { unpack } = require('./crypto.cjs');
const task = require('./task.cjs');
const fs = require('node:fs');
const path = require('node:path');

async function main(operation) {
  const requestId = process.env.QUARK_REQUEST_ID;
  if (!/^[a-f0-9-]{36}$/i.test(requestId || '')) throw new Error('Invalid request identifier.');
  const context = `request:${process.env.GITHUB_REPOSITORY}:${requestId}`;
  const privateKey = await loadInputKey();
  const input = JSON.parse(unpack(JSON.parse(process.env.QUARK_ENCRYPTED_REQUEST), privateKey, context).toString('utf8'));
  if (input.operation !== operation || input.request_id !== requestId) throw new Error('Request operation mismatch.');
  if (operation === 'read') {
    if (typeof input.keyword !== 'string') throw new Error('A filename keyword is required.');
    process.env.QUARK_KEYWORD = input.keyword;
    process.env.QUARK_MAX_FILES = String(input.max_files);
    task.readMarkdown();
  } else if (operation === 'browse') {
    if (input.folder != null && typeof input.folder !== 'string') throw new Error('Invalid folder name.');
    if (input.folder_fid != null && typeof input.folder_fid !== 'string') throw new Error('Invalid folder identifier.');
    process.env.QUARK_FOLDER = input.folder || '';
    process.env.QUARK_FOLDER_FID = input.folder_fid || '';
    task.browseDirectory();
  } else if (operation === 'authorize-finish') {
    if (typeof input.auth_code !== 'string' || !input.auth_code.trim()) throw new Error('Authorization code is missing.');
    process.env.QUARK_AUTH_CODE = input.auth_code;
    task.authorize('finish');
  } else throw new Error('Unsupported operation.');
}

main(process.argv[2]).catch((error) => {
  const directory = process.env.QUARK_RESULT_DIR;
  if (directory && fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) if (/^\d{3}\.md$/.test(name)) fs.unlinkSync(path.join(directory, name));
  }
  task.writeJson('manifest.json', { status: 'failed', message: task.safeMessage(error.message, process.env.QUARK_AUTH_CODE) });
  console.error('The request failed. Details are returned only in the encrypted result.');
  process.exitCode = 1;
});

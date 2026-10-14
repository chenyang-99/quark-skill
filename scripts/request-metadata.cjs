'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

try {
  const input = JSON.parse(fs.readFileSync('request.json', 'utf8'));
  if (!/^[a-f0-9-]{36}$/i.test(input.request_id || '') ||
      process.env.GITHUB_REF_NAME !== `quark-requests/${input.request_id}` ||
      !['read', 'browse', 'authorize-start', 'authorize-finish', 'delivery-test'].includes(input.operation)) {
    throw new Error('Invalid request metadata.');
  }
  const object = crypto.createPublicKey(input.result_public_key);
  if (object.asymmetricKeyType !== 'rsa' || object.asymmetricKeyDetails.modulusLength < 2048) throw new Error('Invalid response key.');
  const publicKey = object.export({ type: 'spki', format: 'pem' });
  const encrypted = input.encrypted_request ? JSON.stringify(input.encrypted_request) : '';
  fs.appendFileSync(process.env.GITHUB_ENV,
    `QUARK_REQUEST_ID=${input.request_id}\nQUARK_OPERATION=${input.operation}\nQUARK_ENCRYPTED_REQUEST=${encrypted}\n` +
    `QUARK_RESULT_PUBLIC_KEY<<QUARK_PUBLIC_KEY\n${publicKey}QUARK_PUBLIC_KEY\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `request_id=${input.request_id}\noperation=${input.operation}\n`);
} catch {
  console.error('Invalid encrypted request metadata.');
  process.exitCode = 1;
}

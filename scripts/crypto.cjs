'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function keyPair() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
}

function pack(bytes, publicKey, context) {
  const keyObject = crypto.createPublicKey(publicKey);
  if (keyObject.asymmetricKeyType !== 'rsa' || keyObject.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('An RSA public key of at least 2048 bits is required.');
  }
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const encryptedKey = crypto.publicEncrypt({ key: keyObject,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { version: 1, algorithm: 'RSA-OAEP-SHA256+AES-256-GCM', context,
    encrypted_key: encryptedKey.toString('base64'), iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
}

function unpack(envelope, privateKey, expectedContext) {
  if (envelope.version !== 1 || envelope.algorithm !== 'RSA-OAEP-SHA256+AES-256-GCM' ||
      envelope.context !== expectedContext || !/^[a-f0-9]{24}$/i.test(envelope.iv || '') ||
      !/^[a-f0-9]{32}$/i.test(envelope.tag || '')) throw new Error('Invalid encrypted message.');
  const key = crypto.privateDecrypt({ key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  Buffer.from(envelope.encrypted_key, 'base64'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
  cipher.setAAD(Buffer.from(expectedContext));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]);
}

function allowedName(name) {
  return /^(?:manifest\.json|authorization\.json|\d{3}\.md)$/.test(name);
}

function encryptDirectory(source, target, publicKey, context) {
  if (!fs.existsSync(source)) return false;
  const files = fs.readdirSync(source).filter(allowedName).map((name) => ({ name,
    data: fs.readFileSync(path.join(source, name)).toString('base64') }));
  if (!files.length) return false;
  const envelope = pack(Buffer.from(JSON.stringify({ files })), publicKey, context);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(target, 'encrypted-result.json'), JSON.stringify(envelope), { mode: 0o600 });
  return true;
}

function decryptDirectory(source, target, privateKey, context) {
  const envelope = JSON.parse(fs.readFileSync(source, 'utf8'));
  const payload = JSON.parse(unpack(envelope, privateKey, context).toString('utf8'));
  if (!Array.isArray(payload.files) || payload.files.some((file) => !allowedName(file.name) || typeof file.data !== 'string')) {
    throw new Error('Unexpected result filenames.');
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of payload.files) fs.writeFileSync(path.join(target, file.name), Buffer.from(file.data, 'base64'), { mode: 0o600 });
}

module.exports = { keyPair, pack, unpack, encryptDirectory, decryptDirectory };
if (require.main === module) {
  try {
    const [mode, first, second, third, context] = process.argv.slice(2);
    if (mode === 'keygen') {
      const pair = keyPair();
      fs.mkdirSync(first, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(first, 'result.private.pem'), pair.privateKey, { mode: 0o600 });
      fs.writeFileSync(path.join(first, 'result.public.pem'), pair.publicKey, { mode: 0o600 });
    } else if (mode === 'request') {
      const bytes = fs.readFileSync(0);
      const envelope = pack(bytes, fs.readFileSync(first, 'utf8'), second);
      process.stdout.write(JSON.stringify(envelope));
    } else if (mode === 'decrypt') {
      decryptDirectory(first, second, fs.readFileSync(third, 'utf8'), context);
    } else if (mode === 'encrypt-results') {
      const publicKey = process.env.QUARK_RESULT_PUBLIC_KEY;
      const binding = `result:${process.env.GITHUB_REPOSITORY}:${process.env.QUARK_REQUEST_ID}`;
      const directory = process.env.QUARK_RESULT_DIR;
      if (!fs.existsSync(directory) || !fs.readdirSync(directory).some(allowedName)) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ status: 'failed',
          message: 'Workflow stopped before producing results. Check QUARK_STATE_KEY setup and the workflow run.' }));
      }
      encryptDirectory(process.env.QUARK_RESULT_DIR, process.env.QUARK_ENCRYPTED_DIR, publicKey, binding);
      console.log('Only encrypted results will be uploaded.');
    } else throw new Error('Unsupported crypto operation.');
  } catch {
    console.error('Encrypted transport failed; no plaintext result was published.');
    process.exitCode = 1;
  }
}

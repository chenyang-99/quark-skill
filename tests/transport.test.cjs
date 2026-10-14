'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { keyPair, pack, unpack, encryptDirectory, decryptDirectory } = require('../scripts/crypto.cjs');

test('encrypted requests hide filenames and one-time authorization codes', () => {
  const pair = keyPair(), context = 'request:owner/repo:identifier';
  const bytes = Buffer.from(JSON.stringify({ keyword: 'private-note.md', auth_code: 'private-one-time-code' }));
  const message = pack(bytes, pair.publicKey, context);
  assert.ok(!JSON.stringify(message).includes('private-note.md'));
  assert.ok(!JSON.stringify(message).includes('private-one-time-code'));
  assert.deepEqual(unpack(message, pair.privateKey, context), bytes);
  assert.throws(() => unpack(message, pair.privateKey, 'request:owner/repo:different'));
});

test('encrypted result cannot be decrypted by another Agent key', () => {
  const pair = keyPair(), other = keyPair();
  const message = pack(Buffer.from('Markdown result'), pair.publicKey, 'result:repo:id');
  assert.throws(() => unpack(message, other.privateKey, 'result:repo:id'));
  message.tag = '00'.repeat(16);
  assert.throws(() => unpack(message, pair.privateKey, 'result:repo:id'));
});

test('only approved result files are included in the encrypted public packet', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plain = path.join(root, 'plain'), sealed = path.join(root, 'sealed'), result = path.join(root, 'decoded');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, '001.md'), '# Private Markdown\n');
  fs.writeFileSync(path.join(plain, 'manifest.json'), JSON.stringify({ status: 'complete' }));
  fs.writeFileSync(path.join(plain, 'config.json'), 'must not leave the runner');
  const pair = keyPair();
  encryptDirectory(plain, sealed, pair.publicKey, 'result:repo:id');
  const packet = path.join(sealed, 'encrypted-result.json');
  assert.deepEqual(fs.readdirSync(sealed), ['encrypted-result.json']);
  assert.ok(!fs.readFileSync(packet, 'utf8').includes('Private Markdown'));
  decryptDirectory(packet, result, pair.privateKey, 'result:repo:id');
  assert.equal(fs.readFileSync(path.join(result, '001.md'), 'utf8'), '# Private Markdown\n');
  assert.ok(!fs.existsSync(path.join(result, 'config.json')));
});

test('result decoder rejects paths outside its result directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pair = keyPair();
  const packet = pack(Buffer.from(JSON.stringify({ files: [{ name: '../outside.md', data: 'YQ==' }] })), pair.publicKey, 'result:repo:id');
  const file = path.join(root, 'packet.json');
  fs.writeFileSync(file, JSON.stringify(packet));
  assert.throws(() => decryptDirectory(file, path.join(root, 'result'), pair.privateKey, 'result:repo:id'));
  assert.ok(!fs.existsSync(path.join(root, 'outside.md')));
});

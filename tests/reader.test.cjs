'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { seal, unseal } = require('../scripts/state.cjs');
const { parseOutput, markdownCandidates, exportMarkdown, safeMessage } = require('../scripts/task.cjs');

test('state is authenticated, scoped to its repository, and hides plaintext', () => {
  const key = 'ab'.repeat(32);
  const bytes = Buffer.from('opaque credential fixture, never a real account');
  const encrypted = seal(bytes, key, 'owner/private-repository');
  assert.ok(!encrypted.includes(bytes.toString()));
  assert.deepEqual(unseal(encrypted, key, 'owner/private-repository'), bytes);
  assert.deepEqual(unseal(encrypted, `\n${key}\n`, 'owner/private-repository'), bytes);
  assert.throws(() => unseal(encrypted, 'cd'.repeat(32), 'owner/private-repository'));
  assert.throws(() => unseal(encrypted, key, 'owner/different-repository'));
  const tampered = JSON.parse(encrypted);
  tampered.tag = '00'.repeat(16);
  assert.throws(() => unseal(JSON.stringify(tampered), key, 'owner/private-repository'));
});

test('progress or a started process is not business success', () => {
  assert.throws(() => parseOutput('{"type":"progress","msg":"waiting"}\n'));
  assert.equal(parseOutput('a diagnostic\n{"type":"result","code":-103,"msg":"not bound"}\n').result.code, -103);
});

test('Markdown matching excludes directories, deduplicates FID tails and refuses truncation', () => {
  const rows = [
    { fid: 'a|same', filename: 'first.md' },
    { fid: 'b|same', filename: 'alias.md' },
    { fid: 'pdf', filename: 'document.pdf' },
    { fid: 'folder', filename: 'folder.md', category: 0 },
    { fid: 'other', filename: 'second.markdown' },
  ];
  assert.equal(markdownCandidates(rows, 5).length, 2);
  assert.throws(() => markdownCandidates(rows, 1), /narrow/);
  assert.throws(() => markdownCandidates([{ fid: 'large', filename: 'large.md', size: 6 * 1024 * 1024 }], 5));
});

test('export rejects outside paths, symbolic links and invalid UTF-8', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  const external = path.join(root, 'outside.md');
  fs.writeFileSync(external, '# outside');
  assert.throws(() => exportMarkdown(external, staging, path.join(root, 'output.md')));
  const link = path.join(staging, 'symlink.md');
  fs.symlinkSync(external, link);
  assert.throws(() => exportMarkdown(link, staging, path.join(root, 'output.md')));
  const invalid = path.join(staging, 'invalid.md');
  fs.writeFileSync(invalid, Buffer.from([0xff]));
  assert.throws(() => exportMarkdown(invalid, staging, path.join(root, 'output.md')));
});

test('error messages redact the one-time authorization code', () => {
  assert.ok(!safeMessage('bad: ONE_TIME_SECRET', 'ONE_TIME_SECRET').includes('ONE_TIME_SECRET'));
});

test('authorization failures preserve the official reason only in private results', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-auth-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'skill');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'scripts/quark-drive.cjs'),
    `console.log(JSON.stringify({type:'result',code:-108,msg:'获取授权地址失败'})); process.exitCode=1;`);
  const result = path.join(root, 'result');
  const child = spawnSync(process.execPath, [path.join(__dirname, '../scripts/task.cjs'), 'authorize', 'start'], {
    encoding: 'utf8', env: { ...process.env, QUARK_SKILL_DIR: skill, QUARK_RESULT_DIR: result },
  });
  assert.equal(child.status, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(result, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.match(manifest.message, /code -108.*获取授权地址失败/);
  assert.ok(!child.stderr.includes('获取授权地址失败'));
  assert.ok(!child.stdout.includes('获取授权地址失败'));
});

test('reader consumes the full artifact and exports Markdown, not bounded preview items', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'skill');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'scripts/quark-drive.cjs'), `
    const fs=require('node:fs'),path=require('node:path');
    const args=process.argv.slice(2);
    const print=(value)=>console.log(JSON.stringify(value));
    if(args[0]==='search'){
      const file=path.join(process.env.FIXTURE_ROOT,'complete.jsonl');
      fs.writeFileSync(file,JSON.stringify({fid:'actual',filename:'note.md',size:13})+'\\n');
      print({type:'result',code:0,action:'search',data:{file_list:[]}});
      print({type:'artifact',code:0,action:'search',data:{file_path:file}});
    }else if(args[0]==='download'){
      const out=args[args.indexOf('--output-dir')+1];
      const file=path.join(out,'note.md');
      fs.writeFileSync(file,'# Cloud note\\n');
      print({type:'result',code:0,action:'download',data:{filePath:file}});
    }else process.exit(1);
  `);
  const result = path.join(root, 'result');
  const child = spawnSync(process.execPath, [path.join(__dirname, '../scripts/task.cjs'), 'read'], {
    encoding: 'utf8', env: { ...process.env, QUARK_SKILL_DIR: skill, QUARK_KEYWORD: 'note.md',
      QUARK_RESULT_DIR: result, FIXTURE_ROOT: root },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.readFileSync(path.join(result, '001.md'), 'utf8'), '# Cloud note\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(result, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.files[0].name, 'note.md');
});

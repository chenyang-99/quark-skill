'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 20;
const SESSION_ID = `${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(3).toString('hex')}`;

function parseOutput(stdout) {
  const rows = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const result = rows.findLast((row) => row.type === 'result');
  if (!result || typeof result.code !== 'number') throw new Error('Official CLI did not return a final business result.');
  return { result, rows };
}

function safeMessage(message, secret = '') {
  let value = String(message || 'Official CLI request failed.');
  if (secret) value = value.replaceAll(secret, '[REDACTED]');
  return value.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|agent_auth_code|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .slice(0, 2000);
}

function runCli(args, input, { allowFailure = false } = {}) {
  const skill = process.env.QUARK_SKILL_DIR || path.join(os.homedir(), '.agents/skills/quarkclouddrive');
  const cli = path.join(skill, 'scripts/quark-drive.cjs');
  const child = spawnSync(process.execPath,
    ['--require', path.join(__dirname, 'env-proxy.cjs'), cli, ...args,
      '--session-input', input, '--session-id', SESSION_ID],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (child.error) throw new Error('Official CLI could not finish the request within the execution limits.');
  const output = parseOutput(child.stdout);
  if (!allowFailure && (child.status !== 0 || output.result.code !== 0)) {
    throw new Error(safeMessage(output.result.msg, process.env.QUARK_AUTH_CODE));
  }
  return output;
}

function markdownCandidates(items, limit) {
  const candidates = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item.fid !== 'string' || typeof item.filename !== 'string' ||
        !/\.(md|markdown)$/i.test(item.filename) || String(item.file_type) === '0' || item.category === 0) continue;
    const tail = item.fid.includes('|') ? item.fid.slice(item.fid.lastIndexOf('|') + 1) : '';
    const identity = tail || item.fid;
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push(item);
  }
  // Refuse silent truncation: the caller must narrow the file name or scope.
  if (candidates.length > limit) throw new Error(`Matched ${candidates.length} Markdown files; narrow the query (limit ${limit}).`);
  for (const item of candidates) {
    if (typeof item.size === 'number' && item.size > MAX_FILE_BYTES) throw new Error('A selected Markdown file exceeds 5 MiB.');
  }
  return candidates;
}

function exportMarkdown(source, staging, target) {
  const actual = fs.realpathSync(source);
  const allowed = fs.realpathSync(staging);
  if (!actual.startsWith(allowed + path.sep)) throw new Error('CLI returned a file outside the requested cloud directory.');
  if (!/\.(md|markdown)$/i.test(actual)) throw new Error('Retrieved file is not Markdown.');
  const stat = fs.statSync(actual);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid or oversized Markdown file.');
  const bytes = fs.readFileSync(actual);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  return stat.size;
}

function resultDirectory() {
  const directory = process.env.QUARK_RESULT_DIR || path.join(os.tmpdir(), 'quark-result');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function writeJson(filename, value) {
  fs.writeFileSync(path.join(resultDirectory(), filename), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function authorize(action) {
  if (action === 'start') {
    const { result } = runCli(['login'], '为 GitHub 上的夸克 Markdown 读取工具获取授权入口', { allowFailure: true });
    if (result.code === -118) throw new Error('This runner already has an authorized account.');
    const match = String(result.msg || '').match(/https:\/\/pan\.quark\.cn\/open\/v1\/oauth\/agent[^\s\\]+/);
    if (!match) throw new Error('The official service did not provide an authorization URL.');
    const url = new URL(match[0]);
    if (url.hostname !== 'pan.quark.cn' || url.protocol !== 'https:') throw new Error('Unexpected authorization URL.');
    writeJson('authorization.json', { status: 'awaiting_user', url: url.href });
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `请打开[夸克官方授权页](${url.href})完成授权，将一次性授权码交给 Agent，由 Agent 保存到 QUARK_AUTH_CODE Secret 后运行 finish。\n`);
    console.log('Official authorization link generated; complete binding before reading files.');
  } else if (action === 'finish') {
    const code = process.env.QUARK_AUTH_CODE;
    if (!code) throw new Error('QUARK_AUTH_CODE is missing from repository Secrets.');
    const { result } = runCli(['login', '--token', code], '完成 GitHub 夸克网盘账号授权');
    writeJson('authorization.json', { status: 'bound', message: safeMessage(result.data?.msg || result.msg, code) });
    console.log('Official account binding completed.');
  } else throw new Error('Expected start or finish.');
}

function readMarkdown() {
  const keyword = (process.env.QUARK_KEYWORD || '').trim();
  if (!keyword || keyword.length > 50) throw new Error('Provide a file-name keyword of 1–50 characters.');
  const limit = Number(process.env.QUARK_MAX_FILES || 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FILES) throw new Error('max_files must be 1–20.');
  const input = `读取夸克网盘中匹配“${keyword}”的 Markdown 文件`;
  const { result, rows } = runCli(['search', '--keyword', keyword, '--stdout-only'], input);
  const artifact = rows.findLast((row) => row.type === 'artifact' && row.action === 'search');
  if (!artifact?.data?.file_path) throw new Error('Search succeeded without a complete result artifact.');
  const lines = fs.readFileSync(artifact.data.file_path, 'utf8').split(/\r?\n/).filter(Boolean);
  const files = markdownCandidates(lines.map((line) => JSON.parse(line)), limit);
  const manifest = { request_id: process.env.QUARK_REQUEST_ID || '', status: 'complete',
    matched_count: files.length, files: [], notices: [] };
  if (result.notice?.text) manifest.notices.push(result.notice.text);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-md-'));
  try {
    for (const [index, file] of files.entries()) {
      const output = path.join(staging, String(index + 1));
      fs.mkdirSync(output, { mode: 0o700 });
      const { result: download } = runCli(['download', '--fid', file.fid, '--output-dir', output], input);
      const data = download.data;
      if (!data?.filePath) throw new Error('The official reader did not return a file path.');
      const name = `${String(index + 1).padStart(3, '0')}.md`;
      const size = exportMarkdown(data.filePath, output, path.join(resultDirectory(), name));
      manifest.files.push({ name: file.filename, result_file: name, bytes: size });
      if (download.notice?.text) manifest.notices.push(download.notice.text);
    }
    writeJson('manifest.json', manifest);
    console.log(`Markdown read complete: ${manifest.files.length} file(s).`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { parseOutput, safeMessage, markdownCandidates, exportMarkdown };
if (require.main === module) {
  try {
    if (process.argv[2] === 'authorize') authorize(process.argv[3]);
    else if (process.argv[2] === 'read') readMarkdown();
    else throw new Error('Expected authorize or read.');
  } catch (error) {
    // Remove incomplete documents so a failed task cannot look like full success.
    const directory = resultDirectory();
    for (const name of fs.readdirSync(directory)) if (/^\d{3}\.md$/.test(name)) fs.unlinkSync(path.join(directory, name));
    writeJson('manifest.json', { status: 'failed', message: safeMessage(error.message, process.env.QUARK_AUTH_CODE) });
    console.error(safeMessage(error.message, process.env.QUARK_AUTH_CODE));
    process.exitCode = 1;
  }
}

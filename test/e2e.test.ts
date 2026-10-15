import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const root = mkdtempSync(join(tmpdir(), 'tmgr-notify-e2e-'));
let counter = 0;
const fresh = (label: string) => join(root, `${label}-${counter++}`);

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('tmgr 1.0.1'); process.exit(0); }
if (process.env.FAKE_ARGV) fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(args));
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
const mode = process.env.FAKE_MODE || args[0];
if (mode === 'echo') { process.stdin.pipe(process.stdout); }
else if (mode === 'wait') {
  process.on('SIGTERM', () => { fs.writeFileSync(process.env.FAKE_SIGNAL, 'SIGTERM'); process.exit(0); });
  fs.writeFileSync(process.env.FAKE_READY, 'ready');
  setInterval(() => {}, 1000);
} else if (mode === 'mcp') {
  const tools = ['notify_user', 'alarm', 'alarm_status', 'tmgr_cli'].map((name) => ({ name }));
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tmgr', version: '1.0.1' } }
        : msg.method === 'tools/list' ? { tools } : null;
      if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    }
  });
}
`;

function makeFake(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(root, 'fake-'));
  const bin = join(dir, 'tmgr');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

function baseEnv(extraPath: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: mkdtempSync(join(root, 'home-')),
    PATH: [...extraPath, dirname(process.execPath)].join(':'),
    ...extra,
  };
}

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

function start(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));
  const done = new Promise<Result>((resolve) => {
    child.on('close', (code, signal) =>
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }),
    );
  });
  return { child, done };
}

async function run(args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Promise<Result> {
  const { child, done } = start(args, env);
  child.stdin.end(input);
  return done;
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(cond(), 'timed out waiting');
}

async function mcpExchange(env: NodeJS.ProcessEnv): Promise<Result> {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]
    .map((m) => JSON.stringify(m))
    .join('\n');
  return run(['mcp'], env, Buffer.from(`${input}\n`));
}

function assertMcp(res: Result): void {
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.toString().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const [init, list] = lines.map((l) => JSON.parse(l));
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'tmgr');
  assert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ['notify_user', 'alarm', 'alarm_status', 'tmgr_cli'],
  );
}

test('mcp via PATH speaks only JSON-RPC on stdout', async () => {
  const { dir } = makeFake();
  assertMcp(await mcpExchange(baseEnv([dir])));
});

test('mcp via TMGR_BIN speaks only JSON-RPC on stdout', async () => {
  const { bin } = makeFake();
  assertMcp(await mcpExchange(baseEnv([], { TMGR_BIN: bin })));
});

test('no args runs mcp', async () => {
  const { dir } = makeFake();
  const log = fresh('argv');
  const res = await run([], baseEnv([dir], { FAKE_ARGV: log, FAKE_EXIT: '0' }));
  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['mcp']);
});

test('stdin to stdout passthrough is byte-exact', async () => {
  const { bin } = makeFake();
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]), Buffer.from('plain\r\n'), Buffer.alloc(70000, 0xab)]);
  const res = await run(['alarm'], baseEnv([], { TMGR_BIN: bin, FAKE_MODE: 'echo' }), bytes);
  assert.equal(res.code, 0);
  assert.deepEqual(res.stdout, bytes);
});

test('child exit code is passed through', async () => {
  const { bin } = makeFake();
  const res = await run(['alarm'], baseEnv([], { TMGR_BIN: bin, FAKE_EXIT: '7' }));
  assert.equal(res.code, 7);
});

test('SIGTERM is forwarded to the child', async () => {
  const { bin } = makeFake();
  const ready = fresh('ready');
  const signal = fresh('signal');
  const { child, done } = start(['alarm'], baseEnv([], { TMGR_BIN: bin, FAKE_MODE: 'wait', FAKE_READY: ready, FAKE_SIGNAL: signal }));
  await until(() => existsSync(ready));
  child.kill('SIGTERM');
  const res = await done;
  assert.equal(readFileSync(signal, 'utf8'), 'SIGTERM');
  assert.ok(res.code === 0 || res.signal === 'SIGTERM');
});

test('send maps to tmgr notify', async () => {
  const { bin } = makeFake();
  const log = fresh('argv');
  const env = baseEnv([], { TMGR_BIN: bin, FAKE_ARGV: log });
  await run(['send', '--title', 'T', '--body', 'B', '--priority', 'high', '--link', 'https://x.test'], env);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['notify', '--title', 'T', '--priority', 'high', '--link', 'https://x.test', 'B']);
  await run(['send', '--title', 'Only'], env);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['notify', '--title', 'Only', 'Only']);
});

test('send without --title fails', async () => {
  const res = await run(['send'], baseEnv([]));
  assert.equal(res.code, 1);
  assert.equal(res.stderr, 'tmgr-notify send: --title is required\n');
});

test('alarm args pass through', async () => {
  const { bin } = makeFake();
  const log = fresh('argv');
  await run(['alarm', '--message', 'wake', '--wait'], baseEnv([], { TMGR_BIN: bin, FAKE_ARGV: log }));
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['alarm', '--message', 'wake', '--wait']);
});

test('hooks map to tmgr hook', async () => {
  const { bin } = makeFake();
  const cases: [string[], string[]][] = [
    [['hook', 'notification'], ['hook', 'claude', 'notification']],
    [['hook', 'prompt'], ['hook', 'claude', 'user-prompt-submit']],
    [['hook', 'stop'], ['hook', 'claude', 'stop']],
    [['hook', 'codex', '{"a":1}'], ['hook', 'codex', '{"a":1}']],
  ];
  for (const [input, expected] of cases) {
    const log = fresh('argv');
    const res = await run(input, baseEnv([], { TMGR_BIN: bin, FAKE_ARGV: log, FAKE_EXIT: '3' }));
    assert.equal(res.code, 0, input.join(' '));
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), expected);
  }
});

test('hook mode exits 0 with empty stdout when the binary cannot be resolved', async () => {
  const res = await run(['hook', 'stop'], baseEnv([], { TMGR_BIN: join(root, 'missing-tmgr') }));
  assert.equal(res.code, 0);
  assert.equal(res.stdout.length, 0);
  assert.match(res.stderr, /TMGR_BIN/);
});

test('unknown hook exits 0 and unknown command exits 1', async () => {
  const hook = await run(['hook', 'nope'], baseEnv([]));
  assert.equal(hook.code, 0);
  assert.equal(hook.stdout.length, 0);
  const cmd = await run(['frobnicate'], baseEnv([]));
  assert.equal(cmd.code, 1);
  assert.equal(cmd.stderr, 'tmgr-notify: unknown command "frobnicate"\n');
});

test('resolution errors outside hook mode exit 1 on stderr', async () => {
  const res = await run(['alarm'], baseEnv([], { TMGR_BIN: join(root, 'missing-tmgr') }));
  assert.equal(res.code, 1);
  assert.equal(res.stdout.length, 0);
  assert.match(res.stderr, /^tmgr-notify: /);
});

test('legacy env file with loose permissions prints a hint', async () => {
  const { bin } = makeFake();
  const env = baseEnv([], { TMGR_BIN: bin, FAKE_EXIT: '0' });
  const dir = join(env.HOME as string, '.config', 'tmgr-notify');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'env');
  writeFileSync(file, 'TMGR_NOTIFY_TOKEN=x\n');
  chmodSync(file, 0o644);
  assert.match((await run(['alarm'], env)).stderr, /chmod 600/);
  chmodSync(file, 0o600);
  assert.equal((await run(['alarm'], env)).stderr, '');
});

test('--help and --version', async () => {
  const help = await run(['--help'], baseEnv([]));
  assert.equal(help.code, 0);
  assert.match(help.stdout.toString(), /TMGR_BIN/);
  const version = await run(['--version'], baseEnv([]));
  assert.equal(version.code, 0);
  assert.equal(version.stdout.toString(), `tmgr-notify ${PKG_VERSION}\n`);
});

test('hook mode drops child stdout', async () => {
  const { bin } = makeFake();
  const res = await run(['hook', 'stop'], baseEnv([], { TMGR_BIN: bin, FAKE_STDOUT: 'noise', FAKE_EXIT: '0' }));
  assert.equal(res.code, 0);
  assert.equal(res.stdout.length, 0);
});

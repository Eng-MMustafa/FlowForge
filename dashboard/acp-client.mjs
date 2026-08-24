// acp-client.mjs - Minimal ACP (Agent Client Protocol) host for Devin CLI.
// Speaks newline-delimited JSON-RPC 2.0 over stdio to `devin acp`.
// Auth: WINDSURF_API_KEY env (documented credential source), falling back to
// the stored credentials file, or the ACP authenticate request at runtime.
//
// Probe mode: node acp-client.mjs "<cwd>" "<prompt>"  -> streams updates, exits.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_CLI = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Devin',
  'resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', 'devin.exe');

export function readStoredKey() {
  // Never print or return the key to logs beyond use in env.
  const credFile = path.join(process.env.APPDATA || '', 'devin', 'credentials.toml');
  try {
    const m = fs.readFileSync(credFile, 'utf8').match(/windsurf_api_key\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// One ACP conversation as a handle: { promise, kill, proc }.
// onUpdate(updateJson) receives every session/update payload.
export function startAcp({ cwd, prompt, model, cliPath = process.env.DEVIN_CLI || DEFAULT_CLI, onUpdate = () => {}, timeoutMs = 30 * 60 * 1000 }) {
  const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
  if (!env.WINDSURF_API_KEY) {
    const key = readStoredKey();
    if (key) env.WINDSURF_API_KEY = key;
  }
  const args = ['acp'];
  if (model) args.push('--model', model);

  // Test hook: a .mjs/.js path executes through the current node binary.
  const viaNode = /\.(mjs|js)$/i.test(cliPath);
  const cmd = viaNode ? process.execPath : cliPath;
  const cmdArgs = viaNode ? [cliPath, ...args] : args;
  const proc = spawn(cmd, cmdArgs, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let settled = false;
  const promise = new Promise((resolve, reject) => {
    runConversation(resolve, reject);
  });
  const kill = () => { try { proc.kill(); } catch {} };

  async function runConversation(resolve, reject) {

  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject}
  let buffer = '';
  let sessionId = null;

  const send = (obj) => { proc.stdin.write(JSON.stringify(obj) + '\n'); };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { onUpdate({ parseError: line.slice(0, 200) }); continue; }

      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        continue;
      }
      if (msg.method === 'session/update') {
        onUpdate(msg.params && msg.params.update ? msg.params.update : msg.params);
        continue;
      }
      if (msg.method === 'session/request_permission') {
        // Auto-grant the most permissive offered option: dashboard gates are
        // our control layer, so in-run prompts must not stall the session.
        const opts = (msg.params && msg.params.options) || [];
        const allow = opts.find((o) => o.kind === 'allow_always') || opts.find((o) => o.kind === 'allow_once') || opts[0];
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow && allow.optionId } } });
        onUpdate({ permission: 'auto-approved', toolCallId: msg.params && msg.params.toolCallId });
        continue;
      }
      if (msg.id !== undefined && msg.method) {
        // Unknown host request (fs/terminal etc.): we advertise no such
        // capabilities, but answer errors defensively so nothing hangs.
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by this host' } });
        continue;
      }
      onUpdate({ notification: msg.method || 'unknown' });
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += d; });

  const killer = setTimeout(() => {
    try { proc.kill(); } catch {}
    if (!settled) { settled = true; reject(new Error('ACP timeout')); }
  }, timeoutMs);

  try {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'flowforge-dashboard', title: 'FlowForge', version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    const authMethods = (init && init.authMethods) || [];
    // `authenticate` can start an interactive browser login. With a key in the
    // environment the session usually opens without it, so it is only used as
    // a recovery step when session/new is refused.
    const haveKey = !!env.WINDSURF_API_KEY;
    if (authMethods.length && !haveKey) {
      await request('authenticate', { methodId: authMethods[0].id });
      onUpdate({ authenticated: authMethods[0].id });
    }

    let s;
    try {
      s = await request('session/new', { cwd, mcpServers: [] });
    } catch (e) {
      if (!authMethods.length || !haveKey) throw e;
      onUpdate({ authRetry: e.message });
      await request('authenticate', { methodId: authMethods[0].id });
      onUpdate({ authenticated: authMethods[0].id });
      s = await request('session/new', { cwd, mcpServers: [] });
    }
    sessionId = s.sessionId;
    onUpdate({ sessionCreated: sessionId });

    const result = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
    onUpdate({ stopReason: result && result.stopReason });
    if (!settled) { settled = true; resolve({ stopReason: result && result.stopReason, sessionId }); }
  } catch (e) {
    if (!settled) { settled = true; reject(e); }
  } finally {
    clearTimeout(killer);
    try { if (sessionId) proc.kill(); } catch {}
  }
  }

  return { promise, kill, proc };
}

// Back-compat convenience wrapper.
export function acpPrompt(opts) {
  return startAcp(opts).promise;
}

// ---------- probe mode ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cwd = process.argv[2] || process.cwd();
  const prompt = process.argv[3] || 'Reply with exactly: OK';
  try {
    const out = await acpPrompt({
      cwd, prompt,
      onUpdate: (u) => {
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) process.stdout.write(u.content.text);
        else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) process.stdout.write(`[thought] ${u.content.text}`);
        else if (u.sessionUpdate === 'tool_call') console.log(`\n[tool] ${u.title || u.toolCallId}`);
        else console.log('\n[update]', JSON.stringify(u).slice(0, 300));
      },
    });
    console.log('\nFINAL:', JSON.stringify(out));
    process.exit(0);
  } catch (e) {
    console.error('\nPROBE FAILED:', e.message);
    process.exit(1);
  }
}

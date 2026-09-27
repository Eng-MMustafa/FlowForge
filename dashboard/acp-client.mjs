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
import { devinCliCandidates, agentCredentialsFile } from '../scripts/lib/platform.mjs';

// Installed-with-the-editor path first, then whatever is on PATH.
const DEFAULT_CLI = devinCliCandidates().find((p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}) || 'devin';

export function readStoredKey() {
  // Never print or return the key to logs beyond use in env.
  const credFile = agentCredentialsFile();
  try {
    const m = fs.readFileSync(credFile, 'utf8').match(/windsurf_api_key\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// One ACP conversation as a handle: { promise, kill, close, prompt, proc }.
// onUpdate(updateJson) receives every session/update payload.
// `promise` settles when the FIRST turn ends. With keepAlive the session stays
// open afterwards and `prompt(text)` sends further turns (a dashboard gate
// decision, for instance) until `close()`; without it the process is killed
// as soon as the first turn is over.
// interactiveAuth=false is the default ON PURPOSE: the ACP `authenticate`
// request can pop the CLI's interactive login screen (or a browser tab) while
// the user is just pressing "Generate". The dashboard never wants that behind
// their back - a failed auth must surface as an error, never as a login UI.
export function startAcp({ cwd, prompt, model, cliPath = process.env.DEVIN_CLI || DEFAULT_CLI, onUpdate = () => {}, timeoutMs = 30 * 60 * 1000, interactiveAuth = false, keepAlive = false }) {
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
  let closed = false;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject}
  let sessionId = null;
  const send = (obj) => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* process gone */ } };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('acp session closed')); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  // A dead process must never leave a caller waiting on a reply.
  proc.on('exit', () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error('acp process exited'));
    pending.clear();
  });

  let killer = null;
  const kill = () => { closed = true; clearTimeout(killer); try { proc.kill(); } catch {} };
  const promise = new Promise((resolve, reject) => {
    runConversation(resolve, reject);
  });
  // A later turn on the same session; resolves with its stop reason.
  const followUp = async (text) => {
    if (!sessionId) throw new Error('no acp session yet');
    const r = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    onUpdate({ stopReason: r && r.stopReason });
    return r && r.stopReason;
  };

  async function runConversation(resolve, reject) {

  let buffer = '';

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

  // If the CLI decides to draw its interactive login screen instead of speaking
  // JSON-RPC, that text lands on stdout/stderr - kill the child fast rather
  // than leave a half-open login UI running behind the user's back.
  const ACP_LOGIN_MARKER = /how would you like to log in|not logged in|sign in to continue/i;
  const watchForLogin = (d) => {
    // Only before a session exists: afterwards the phrase could appear inside
    // a legit agent message, and no login screen can be drawn anyway.
    if (sessionId || settled) return;
    if (ACP_LOGIN_MARKER.test(String(d))) {
      settled = true;
      try { proc.kill(); } catch {}
      reject(new Error('devin cli wants interactive login'));
    }
  };
  proc.stdout.on('data', watchForLogin);
  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += d; watchForLogin(d); });

  killer = setTimeout(() => {
    try { proc.kill(); } catch {}
    if (!settled) { settled = true; reject(new Error('ACP timeout')); }
  }, timeoutMs);

  try {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'flowforge-dashboard', title: 'FlowForge', version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    // The ACP host is the SOLE source of credentials (the CLI deliberately
    // ignores the on-disk store in acp mode). With a key we authenticate
    // headlessly - `windsurf-api-key` accepts the key via `_meta.api_key` and
    // never touches a browser or a login screen. The browser PKCE method
    // (`devin-browser`) only ever runs when the caller explicitly opted into
    // interactive auth.
    const haveKey = !!env.WINDSURF_API_KEY;
    if (haveKey) {
      await request('authenticate', { methodId: 'windsurf-api-key', _meta: { api_key: env.WINDSURF_API_KEY } });
      onUpdate({ authenticated: 'windsurf-api-key' });
    } else if (interactiveAuth) {
      await request('authenticate', { methodId: 'devin-browser' });
      onUpdate({ authenticated: 'devin-browser' });
    } else {
      throw new Error('devin acp requires login (no usable credential)');
    }

    let s;
    try {
      s = await request('session/new', { cwd, mcpServers: [] });
    } catch (e) {
      if (!interactiveAuth) throw e;
      onUpdate({ authRetry: e.message });
      await request('authenticate', { methodId: 'devin-browser' });
      onUpdate({ authenticated: 'devin-browser' });
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
    kill();
  } finally {
    // keepAlive: the session outlives the first turn; the overall timeout
    // still bounds the whole conversation.
    if (!keepAlive) { clearTimeout(killer); kill(); }
  }
  }

  return { promise, kill, close: kill, prompt: followUp, proc, sessionId: () => sessionId };
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

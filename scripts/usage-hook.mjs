#!/usr/bin/env node
// usage-hook.mjs - the hook command FlowForge adds to a tool that reports its
// own token usage through hooks (Cursor's `stop` event). It records the usage
// numbers of one event and nothing else - no prompt, no response, no email -
// and never blocks or fails the tool: every error is swallowed, the reply is
// always `{}`.
//
//   node usage-hook.mjs <tool>     (the event JSON arrives on stdin)
import fs from 'node:fs';
import path from 'node:path';
import { usageLogDir } from './lib/platform.mjs';

const tool = String(process.argv[2] || 'unknown').replace(/[^a-z0-9-]/gi, '') || 'unknown';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (raw.length < 5e6) raw += chunk; });
process.stdin.on('end', () => {
  try {
    const e = JSON.parse(raw || '{}');
    const pick = (k) => (typeof e[k] === 'number' ? e[k] : null);
    const record = {
      ts: Date.now(), tool, event: e.hook_event_name || null,
      model: e.model || null, model_id: e.model_id || null,
      input_tokens: pick('input_tokens'), output_tokens: pick('output_tokens'),
      cache_read_tokens: pick('cache_read_tokens'), cache_write_tokens: pick('cache_write_tokens'),
      generation_id: e.generation_id || null, conversation_id: e.conversation_id || null,
      status: e.status || null,
      workspace: Array.isArray(e.workspace_roots) && e.workspace_roots.length ? String(e.workspace_roots[0]) : null,
    };
    if (record.input_tokens !== null || record.output_tokens !== null) {
      const dir = usageLogDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${tool}.jsonl`), `${JSON.stringify(record)}\n`);
    }
  } catch { /* a usage recorder must never break the tool it listens to */ }
  process.stdout.write('{}');
});

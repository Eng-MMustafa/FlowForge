// Platform layer - the ONE place that knows how Windows, macOS and Linux differ.
// Zero dependencies (node builtins only).
//
// Every function takes the platform, the environment and the home directory as
// arguments (defaulting to the real ones) so the test suite can check all three
// platforms from any single machine - no mocking framework, no spawning.
//
// Rule for the rest of the codebase: if you are about to write `process.platform`
// or a path with a drive letter, a `.exe` or `%APPDATA%` in it, add it here first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLATFORMS = ['win32', 'darwin', 'linux'];

const plat0 = () => process.platform;
const home0 = () => os.homedir();

// ---------- the agent CLI's config directory ----------

// Devin keeps its global skills/agents next to its config. The location is
// per-platform, and a user can always override it outright.
export function agentConfigCandidates(plat = plat0(), env = process.env, home = home0()) {
  const out = [];
  if (env.DEVIN_CONFIG_DIR) out.push(env.DEVIN_CONFIG_DIR);
  if (plat === 'win32') {
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'devin'));
  } else if (plat === 'darwin') {
    out.push(path.join(home, 'Library', 'Application Support', 'devin'));
    out.push(path.join(home, '.devin'));
    out.push(path.join(home, '.config', 'devin'));
  } else {
    out.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'devin'));
    out.push(path.join(home, '.devin'));
  }
  return out.filter(Boolean);
}

// First candidate that exists; otherwise the platform's preferred one, so the
// caller can report a precise "not found here" instead of a vague failure.
export function agentConfigDir(opts = {}) {
  const { plat = plat0(), env = process.env, home = home0(), exists = fs.existsSync } = opts;
  const candidates = agentConfigCandidates(plat, env, home);
  return candidates.find((c) => exists(c)) || candidates[0] || '';
}

// The credentials file the agent CLI writes next to its config.
export function agentCredentialsFile(opts = {}) {
  const dir = agentConfigDir(opts);
  return dir ? path.join(dir, 'credentials.toml') : '';
}

// Where the Devin CLI binary sits when it was installed with the editor. PATH
// is always tried first by the callers; these are the "installed but not on
// PATH" fallbacks.
export function devinCliCandidates(plat = plat0(), env = process.env, home = home0()) {
  const tail = ['resources', 'app', 'extensions', 'windsurf', 'devin', 'bin'];
  if (plat === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(local, 'Programs', 'Devin', ...tail, 'devin.exe')];
  }
  if (plat === 'darwin') {
    return [
      path.join('/Applications', 'Devin.app', 'Contents', 'Resources', 'app',
        'extensions', 'windsurf', 'devin', 'bin', 'devin'),
      path.join(home, 'Applications', 'Devin.app', 'Contents', 'Resources', 'app',
        'extensions', 'windsurf', 'devin', 'bin', 'devin'),
    ];
  }
  return [
    path.join('/usr', 'share', 'devin', ...tail, 'devin'),
    path.join(home, '.local', 'share', 'devin', ...tail, 'devin'),
  ];
}

// ---------- links ----------

// Windows needs a junction to link a directory without admin rights; POSIX just
// uses a directory symlink.
export const linkType = (plat = plat0()) => (plat === 'win32' ? 'junction' : 'dir');

export function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// A junction is removed with rmdir, a POSIX symlink with unlink - and a link
// left behind by the other platform must not survive either.
export function removeLink(p) {
  try { fs.unlinkSync(p); return true; } catch { /* fall through */ }
  try { fs.rmdirSync(p); return true; } catch { return false; }
}

// Windows and macOS compare paths case-insensitively; Linux does not.
export const caseInsensitivePaths = (plat = plat0()) => plat !== 'linux';

export function samePath(a, b, plat = plat0()) {
  if (!a || !b) return false;
  const x = path.resolve(a), y = path.resolve(b);
  return caseInsensitivePaths(plat) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ---------- where editors keep their data ----------

// The roots provider descriptors are written against. The rels then match on
// every platform: %APPDATA%\Cursor\User, ~/Library/Application Support/Cursor/User
// and ~/.config/Cursor/User are the same `appdata` + ['Cursor','User'].
export function providerRoots(plat = plat0(), env = process.env, home = home0()) {
  if (plat === 'win32') {
    return {
      local: env.LOCALAPPDATA || '',
      appdata: env.APPDATA || '',
      home: env.USERPROFILE || home || '',
      files: env.ProgramFiles || '',
    };
  }
  if (plat === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return { local: support, appdata: support, home, files: '/Applications' };
  }
  return {
    local: env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
    appdata: env.XDG_CONFIG_HOME || path.join(home, '.config'),
    home,
    files: '/usr/share',
  };
}

// ---------- launching things ----------

export function openUrlCommand(url, plat = plat0()) {
  if (plat === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (plat === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

// Opening an installed application (an editor, for its own sign-in screen).
export function openAppCommand(target, plat = plat0()) {
  if (plat === 'win32') {
    return /\.(exe|cmd|bat)$/i.test(target) ? { cmd: 'cmd', args: ['/c', 'start', '', target] } : null;
  }
  if (plat === 'darwin') return { cmd: 'open', args: target.endsWith('.app') ? ['-a', target] : [target] };
  return { cmd: 'xdg-open', args: [target] };
}

// Killing a run: the agent CLI spawns children, so the whole tree has to go.
// POSIX gets null, meaning "use process.kill on the negated pid" - no process
// needs to be spawned there.
export function killTreeCommand(pid, plat = plat0()) {
  if (plat === 'win32') return { cmd: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  return null;
}

// ---------- interactive login terminals ----------

// A login is an OAuth dance owned by the vendor's CLI: FlowForge only opens a
// real terminal on it. Each platform gets the script flavour it can run.
export function loginScriptFormat(plat = plat0()) {
  if (plat === 'win32') return { ext: '.cmd', newline: '\r\n', mode: 0o644 };
  return { ext: '.command', newline: '\n', mode: 0o755 }; // .command opens in Terminal.app
}

// Turns the vendor's own commands into a runnable script for this platform.
// `steps` are argv arrays; `note` is a human hint printed first.
export function loginScriptLines({ title, note, cliPath, steps, plat = plat0() }) {
  const quoted = (argv) => argv.map((x) => `"${String(x).replace(/"/g, '')}"`).join(' ');
  const safe = (s) => String(s).replace(/[<>|&^`$]/g, '');
  if (plat === 'win32') {
    return [
      '@echo off',
      `title ${safe(title)}`,
      ...(note ? [`echo ${safe(note)}`, 'echo.'] : []),
      `"${cliPath}" ${quoted(steps[0])}`,
      'echo.',
      'echo Verifying...',
      `"${cliPath}" ${quoted(steps[1] || steps[0])}`,
      'echo.',
      'echo Done - go back to the dashboard and press the refresh button.',
      'pause',
    ];
  }
  return [
    '#!/bin/sh',
    `printf '\\033]0;%s\\007' ${JSON.stringify(title)}`,
    ...(note ? [`echo ${JSON.stringify(safe(note))}`, 'echo'] : []),
    `"${cliPath}" ${quoted(steps[0])}`,
    'echo',
    'echo Verifying...',
    `"${cliPath}" ${quoted(steps[1] || steps[0])}`,
    'echo',
    'echo "Done - go back to the dashboard and press the refresh button."',
    'printf "Press Enter to close..."; read _',
  ];
}

// Linux has no single terminal, so the first one actually installed wins.
export const LINUX_TERMINALS = [
  { cmd: 'x-terminal-emulator', args: (f) => ['-e', 'sh', f] },
  { cmd: 'gnome-terminal', args: (f) => ['--', 'sh', f] },
  { cmd: 'konsole', args: (f) => ['-e', 'sh', f] },
  { cmd: 'xfce4-terminal', args: (f) => ['-e', `sh ${f}`] },
  { cmd: 'alacritty', args: (f) => ['-e', 'sh', f] },
  { cmd: 'xterm', args: (f) => ['-e', 'sh', f] },
];

// Returns the command that opens `file` in a visible terminal, or null when the
// machine has none - in which case the caller must tell the user to run it by
// hand instead of pretending a window opened.
export function terminalCommand({ file, title, plat = plat0(), have = null }) {
  if (plat === 'win32') return { cmd: 'cmd', args: ['/c', 'start', title || 'Login', file] };
  if (plat === 'darwin') return { cmd: 'open', args: ['-a', 'Terminal', file] };
  const probe = have || defaultHave;
  for (const t of LINUX_TERMINALS) {
    if (probe(t.cmd)) return { cmd: t.cmd, args: t.args(file) };
  }
  return null;
}

// PATH lookup without executing anything (same rule as the provider registry).
export function defaultHave(cmd, env = process.env, plat = plat0()) {
  return !!whichSync(cmd, env, plat);
}

export function whichSync(cmd, env = process.env, plat = plat0()) {
  const exts = plat === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((x) => x.trim().toLowerCase()).filter(Boolean)
    : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const base = path.join(dir, cmd);
    for (const ext of exts) {
      const candidate = base + ext;
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

// ---------- misc ----------

// npm ships as a .cmd shim on Windows, which cannot be spawned without a shell.
export const npmBin = (name = 'npm', plat = plat0()) => (plat === 'win32' ? `${name}.cmd` : name);

// Where a fresh install lands when the user names no folder.
export function defaultInstallDir(plat = plat0(), env = process.env, home = home0()) {
  if (plat === 'win32') return path.join(env.LOCALAPPDATA || home, 'FlowForge');
  if (plat === 'darwin') return path.join(home, 'Library', 'Application Support', 'FlowForge');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'FlowForge');
}

import { writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

async function trySpawn(cmd, args = []) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      return resolve({ ok: false, err });
    }
    child.on('error', err => resolve({ ok: false, err }));
    setTimeout(() => {
      try { child.unref(); } catch (_) {}
      resolve({ ok: true, cmd, args });
    }, 100);
  });
}

/**
 * Create a Windows script (.bat or .ps1) and open a new terminal to run it.
 * - scriptContent: content to write into the script
 * - fileName: filename to create (default 'sample.bat')
 * - usePowershell: if true create/run a PowerShell script (.ps1)
 * - dir: directory to write the script (default cwd)
 */
export default async function createAndOpenWindowsScript(
  scriptContent = '@echo off\necho Hello from sample.bat\npause\n',
  fileName = 'scripts\sample.bat',
  usePowershell = false,
  dir = process.cwd()
) {
  if (os.platform() !== 'win32') {
    return { ok: false, error: 'Not running on Windows' };
  }

  const ext = usePowershell ? (path.extname(fileName) ? '' : '.ps1') : (path.extname(fileName) ? '' : '.bat');
  const finalName = path.extname(fileName) ? fileName : `${fileName}${ext}`;
  const fullPath = path.resolve(dir, finalName);

  try {
    await writeFile(fullPath, scriptContent, { encoding: 'utf8' });
  } catch (err) {
    return { ok: false, error: `Failed to write script: ${err.message}` };
  }

  // Try Windows Terminal (wt) first, then cmd.exe start, then powershell.exe as fallback
  const attempts = [];

  if (!usePowershell) {
    // run .bat with wt: wt cmd /k "C:\path\to\file.bat"
    attempts.push({ cmd: 'wt', args: ['cmd', '/k', fullPath] });
    // fallback: start a new cmd window
    attempts.push({ cmd: 'cmd.exe', args: ['/c', 'start', 'cmd', '/k', fullPath] });
  } else {
    // run .ps1 with wt using powershell
    attempts.push({ cmd: 'wt', args: ['powershell', '-NoExit', '-File', fullPath] });
    attempts.push({ cmd: 'powershell.exe', args: ['-NoExit', '-File', fullPath] });
    // last resort: use cmd to start powershell
    attempts.push({ cmd: 'cmd.exe', args: ['/c', 'start', 'powershell', '-NoExit', '-File', fullPath] });
  }

  for (const a of attempts) {
    try {
      const res = await trySpawn(a.cmd, a.args);
      if (res.ok) return { ok: true, path: fullPath, launchedWith: res.cmd, args: res.args };
    } catch (_) {}
  }

  return { ok: false, error: 'Failed to launch terminal to run the script' };
}
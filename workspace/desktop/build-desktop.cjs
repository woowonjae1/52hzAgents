const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawn} = require('node:child_process');

const root = __dirname;
const originalOutput = path.join(root, 'release-dist');
let occupied = [], inspectionFailed = false;
if (process.platform === 'win32') {
  try {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const raw = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='52hzAgents.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"],
    {encoding:'utf8', windowsHide:true, timeout:10000}).trim();
    const processes = raw ? JSON.parse(raw) : [];
    occupied = (Array.isArray(processes) ? processes : [processes]).filter(item => {
      if (!item.ExecutablePath) { inspectionFailed = true; return false; }
      return path.resolve(item.ExecutablePath).toLowerCase().startsWith(originalOutput.toLowerCase() + path.sep);
    });
  } catch { inspectionFailed = true; }
}

// electron-builder empties its output directory. Never point it at a live checkout.
const alternate = occupied.length > 0 || inspectionFailed;
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '');
const output = alternate ? path.join(root, 'preview-dist', `${stamp}-${process.pid}`) : originalOutput;
if (!output.startsWith(root + path.sep) || output === root) throw new Error('Unsafe build output path.');
if (alternate) {
  console.log(occupied.length
    ? `[desktop-build] release-dist is in use (PIDs: ${occupied.map(item=>item.ProcessId).join(', ')}).`
    : '[desktop-build] Could not verify that release-dist is unused.');
  console.log(`[desktop-build] Building into a fresh directory: ${output}`);
}

const args = process.argv.slice(2);
if (args.some(arg => /directories\.output|^--config$|^--projectDir/.test(arg))) {
  throw new Error('Use the configured build output; directory overrides are not supported by this safe build command.');
}
const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'out', 'cli', 'cli.js');
const child = spawn(process.execPath, [cli, ...args, `--config.directories.output=${output}`],
  {cwd:root, stdio:'inherit', windowsHide:true});
child.on('error', error => { console.error(`[desktop-build] ${error.message}`); process.exitCode=1; });
child.on('exit', code => {
  if (code !== 0) { process.exitCode=code || 1; return; }
  const executable = path.join(output, 'win-unpacked', '52hzAgents.exe');
  console.log(`\n[desktop-build] Build completed: ${output}`);
  if (fs.existsSync(executable)) console.log(`[desktop-build] Open: ${executable}`);
  if (alternate) console.log('[desktop-build] The running app and existing shortcuts were preserved. Exit the old app from its tray before opening the new executable.');
});

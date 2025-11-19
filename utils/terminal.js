import { spawn } from 'child_process';

const terminal = spawn('gnome-terminal', ['--', 'bash', '-c', '../scripts/sample.sh; exec bash'], {
  detached: true,
  stdio: 'ignore'
});

terminal.unref();


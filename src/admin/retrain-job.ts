import { spawn } from 'child_process';
import { resetModelCache } from '../classifier/intent-classifier';
import { resetActionGateCache } from '../classifier/action-gate';

// ──────────────────────────────────────────────────────────
// Background classifier retrain. Spawns the offline trainer script (Cloudflare
// only, never Anthropic). On success, resets the server's in-memory model +
// action-gate caches so the new model takes effect without a restart.
// Single job at a time.
// ──────────────────────────────────────────────────────────

type State = 'idle' | 'running' | 'done' | 'error';
interface JobStatus { state: State; startedAt: string | null; finishedAt: string | null; message: string; }

let _status: JobStatus = { state: 'idle', startedAt: null, finishedAt: null, message: '' };

export function getRetrainStatus(): JobStatus { return _status; }

export function startRetrain(): JobStatus {
  if (_status.state === 'running') return _status;
  _status = { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, message: 'training…' };

  const child = spawn('npx', ['ts-node', 'scripts/train-intent-classifier.ts'], {
    cwd: process.cwd(),
    shell: true,
    env: process.env,
  });

  let tail = '';
  const capture = (b: Buffer) => { tail = (tail + b.toString()).slice(-2000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  child.on('close', (code) => {
    if (code === 0) {
      resetModelCache();
      resetActionGateCache();
      _status = { state: 'done', startedAt: _status.startedAt, finishedAt: new Date().toISOString(), message: 'model reloaded' };
    } else {
      _status = { state: 'error', startedAt: _status.startedAt, finishedAt: new Date().toISOString(), message: tail.slice(-500) || `exit ${code}` };
    }
  });
  child.on('error', (err) => {
    _status = { state: 'error', startedAt: _status.startedAt, finishedAt: new Date().toISOString(), message: err.message };
  });

  return _status;
}

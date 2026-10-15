import { spawn } from 'node:child_process';

const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function runBinary(bin: string, args: string[], forgiving = false): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit' });
    const handlers = FORWARDED.map((sig) => {
      const handler = () => {
        child.kill(sig);
      };
      process.on(sig, handler);
      return [sig, handler] as const;
    });
    const cleanup = () => handlers.forEach(([sig, handler]) => process.off(sig, handler));

    child.on('error', (err) => {
      cleanup();
      process.stderr.write(`tmgr-notify: cannot run ${bin}: ${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (signal && !forgiving) {
        process.kill(process.pid, signal);
        setTimeout(() => resolve(1), 1000).unref();
        return;
      }
      resolve(code ?? 0);
    });
  });
}

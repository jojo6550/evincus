import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

// Every verification run owns its database and cannot send email or collect money.
export async function isolatedServer() {
  const dir = await mkdtemp(join(tmpdir(), 'evincus-check-'));
  const child = fork(new URL('../../main.js', import.meta.url), [], { execArgv: [], silent: true, env: { ...process.env, PORT: '0', KV_PATH: join(dir, 'kv.sqlite3'), ENVIRONMENT: 'development', CSP_MODE: 'enforce', EMAIL_DISABLED: 'true', RESEND_API_KEY: '', NEWSLETTER_HOUR: '', KEEPALIVE_URL: '', PAYMENT_MODE: 'none', SHIPPING_USD: '0', ADMIN_TOKEN: crypto.randomUUID() } });
  let output = '', errorOutput = '';
  child.stderr.on('data', data => { errorOutput += data; });
  const stop = async () => {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 22000);
      await done; clearTimeout(timer);
    }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Isolated server startup timed out: ${errorOutput}`)), 15000);
      child.stdout.on('data', data => {
        output += data;
        const match = /"event":"runtime.listening"[^\n]*"port":(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Isolated server exited ${code}: ${errorOutput}`)); });
    });
    return { url, child, stop, async metrics() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Metrics timed out')); }, 3000);
        const listener = message => { if (message.type === 'metrics') { clearTimeout(timer); child.off('message', listener); resolve(message); } };
        child.on('message', listener); child.send('metrics');
      });
    } };
  } catch (error) { child.kill(); await stop(); throw error; }
}

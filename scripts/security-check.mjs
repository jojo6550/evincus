// Reports locations only, never matching secret material. CI checks the full
// fetched history; local shallow clones should fetch history before running.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const privatePath = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|\.kv\.sqlite3[^/]*|[^/]+\.(?:pem|key|p12|pfx))$/i;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:re_[A-Za-z0-9]{24,}|sk_live_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,})\b/;
let failures = 0;
for (const file of git('ls-files', '--cached', '--others', '--exclude-standard').trim().split('\n')) {
  if (privatePath.test(file)) { console.error(`Private file is tracked: ${file}`); failures++; }
  if (!/\.(?:js|mjs|json|md|ya?ml|html|txt)$/.test(file)) continue;
  try { if (secret.test(readFileSync(file, 'utf8'))) { console.error(`Possible credential in working file: ${file}`); failures++; } } catch { /* deleted file */ }
}
const history = git('log', '--all', '--format=commit:%h', '--name-only', '--diff-filter=A');
for (const file of new Set(history.split('\n').filter(line => line && !line.startsWith('commit:')))) {
  if (privatePath.test(file)) { console.error(`Private path found in history: ${file}`); failures++; }
}
// Scan textual changes, suppressing the content of any matches.
const patches = git('log', '--all', '--format=', '-p', '--', '*.js', '*.mjs', '*.json', '*.yml', '*.yaml', '*.env', '*.md');
if (patches.split('\n').some(line => line.startsWith('+') && secret.test(line))) {
  console.error('Possible credential in commit history; review in a private secret-scanning tool and rotate if confirmed.'); failures++;
}
console.log(JSON.stringify({ check: 'tracked-files-and-history', failures }));
process.exitCode = failures ? 1 : 0;

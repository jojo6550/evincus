// npm run error 404 -> serves the site and opens the 404 page (also 403/500/502/503/504).
import { ERROR_CODES, BASE, startServer } from './dev.mjs';

const code = Number(process.argv[2]);
if (!ERROR_CODES.includes(code)) {
  console.error(`Usage: npm run error <code>   (codes: ${ERROR_CODES.join(', ')})`);
  process.exit(1);
}
const { port } = await startServer().catch((e) => {
  console.error(e.code === 'EADDRINUSE' ? 'Port in use. Try: PORT=8081 npm run error ' + code : e);
  process.exit(1);
});
console.log(`Error ${code} page: http://localhost:${port}${BASE}/__error/${code}`);

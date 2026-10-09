// npm run error 404 -> the URL of that error page on the local server (also 403/500/502/503/504).
import { ERROR_CODES } from '../server/static.js';

const code = Number(process.argv[2]);
if (!ERROR_CODES.includes(code)) {
  console.error(`Usage: npm run error <code>   (codes: ${ERROR_CODES.join(', ')})`);
  process.exit(1);
}
console.log(`Error ${code} page: http://localhost:8000/__error/${code}
Start the site first with npm run dev; .env must have ENVIRONMENT=development.`);

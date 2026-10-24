// npm run test-email -- --email you@example.com -> sends one test email through the real Resend setup (.env).
import { parseArgs } from 'node:util';
import { sendEmail } from '../server/lib/email.js';

const { email } = parseArgs({ options: { email: { type: 'string' } } }).values;
if (!email) {
  console.error('Usage: npm run test-email -- --email <address>');
  process.exit(1);
}

await sendEmail(process.env, {
  to: email,
  subject: 'Evincus test email',
  html: '<p>Test email from Evincus. Email is working.</p>',
  idempotencyKey: `test-email-${Date.now()}`,
});
console.log(`Sent to ${email}`);

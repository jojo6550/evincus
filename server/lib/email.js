// Resend REST API. The idempotency key stops retries from sending twice.
async function post(env, path, payload, idempotencyKey) {
  if (env.EMAIL_DISABLED === 'true') throw new Error('Email disabled in this environment');
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const recipients = path === '/emails/batch' ? payload.flatMap(e => e.to) : payload.to;
  if (env.EMAIL_TEST_RECIPIENT && recipients.some(to => to !== env.EMAIL_TEST_RECIPIENT)) throw new Error('Recipient blocked in test environment');
  const res = await fetch(`https://api.resend.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status})`);
}

export async function sendEmail(env, { to, subject, html, headers, idempotencyKey }) {
  if (!to) throw new Error('no recipient address');
  await post(env, '/emails', { from: env.EMAIL_FROM, to: [to], subject, html, ...(headers && { headers }) }, idempotencyKey);
}

// Up to 100 separate emails in one call. Resend sends all of them or none.
export async function sendBatch(env, emails, idempotencyKey) {
  if (!emails.length || emails.length > 100) throw new Error('a batch holds 1 to 100 emails');
  await post(env, '/emails/batch', emails.map(e => ({ from: env.EMAIL_FROM, to: [e.to], subject: e.subject, html: e.html, ...(e.headers && { headers: e.headers }) })), idempotencyKey);
}

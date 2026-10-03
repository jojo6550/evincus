// Resend REST API. The idempotency key stops retries from sending twice.
export async function sendEmail(env, { to, subject, html, idempotencyKey }) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  if (!to) throw new Error('no recipient address');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status})`);
}

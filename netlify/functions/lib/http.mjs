export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

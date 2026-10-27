// Admin-only actions that need Supabase's secret key, which must never reach
// the browser: creating learner accounts and setting passwords.
// The caller must be signed in as an active admin (checked below).
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Prefer the new named secret key, fall back to the legacy service_role key.
function secretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default;
    if (k) return k;
  } catch { /* fall through */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // 1. Who is calling? Verify their session token with Supabase Auth.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Not signed in' }, 401);
  const { data: { user }, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !user) return json({ error: 'Not signed in' }, 401);

  // 2. Are they an active admin?
  const { data: me } = await admin.from('profiles').select('role, active').eq('id', user.id).maybeSingle();
  if (!me || me.role !== 'admin' || !me.active) return json({ error: 'Admins only' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  // 3. Do the action.
  if (body.action === 'create_user') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const full_name = String(body.full_name ?? '').trim() || null;
    const role = body.role === 'admin' ? 'admin' : 'learner';
    const password = String(body.password ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);

    // The database only accepts new accounts whose email is on this list.
    const { error: listErr } = await admin.from('allowed_users').upsert({ email, full_name, role }, { onConflict: 'email' });
    if (listErr) return json({ error: listErr.message }, 500);

    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name },
    });
    if (error) {
      const exists = /already|registered|exists/i.test(error.message);
      return json({ error: exists ? 'An account with this email already exists.' : error.message }, exists ? 409 : 400);
    }
    return json({ id: data.user?.id, email });
  }

  if (body.action === 'set_password') {
    const id = String(body.user_id ?? '');
    const password = String(body.password ?? '');
    if (!id) return json({ error: 'Missing user.' }, 400);
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
});

// kickoff-push: sends Universe kick-off alerts. Called once a minute by the
// pg_cron schedule in supabase/push_schema.sql. Deploy it with "Verify JWT"
// off: the schedule proves itself with the x-cron-secret header instead.
//
// The app does the thinking: whenever a Universe is saved it also saves a list
// of its upcoming kick-offs, already worded, under the keys lp_kickoffs_afl and
// lp_kickoffs_nrl in predictor_state:
//   { items: [{ t, title, body, tag }] }      t = kick-off, ms since epoch
// This function only sends the ones that have come due since its last run, to
// everyone who has turned alerts on.
//
// Secrets (Edge Functions > Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT, CRON_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT')!,
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

// A stalled schedule shouldn't fire a backlog of stale alerts when it recovers.
const MAX_LOOKBACK_MS = 10 * 60 * 1000;
const KEYS = ['lp_kickoffs_afl', 'lp_kickoffs_nrl'];

type Item = { t: number; title: string; body: string; tag?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json({ error: 'forbidden' }, 403);
  const now = Date.now();

  const { data: subs, error } = await sb.from('push_subscriptions').select('endpoint,user_id,p256dh,auth');
  if (error) return json({ error: error.message }, 500);
  if (!subs || !subs.length) return json({ sent: 0 });

  const users = [...new Set(subs.map((s) => s.user_id))];
  const [{ data: cursors }, { data: lists }] = await Promise.all([
    sb.from('push_cursor').select('user_id,sent_until').in('user_id', users),
    sb.from('predictor_state').select('user_id,key,value').in('user_id', users).in('key', KEYS),
  ]);

  let sent = 0;
  for (const user of users) {
    const cur = (cursors || []).find((c) => c.user_id === user);
    const from = Math.max(cur ? Date.parse(cur.sent_until) : now - 90_000, now - MAX_LOOKBACK_MS);
    const due: Item[] = (lists || [])
      .filter((l) => l.user_id === user)
      .flatMap((l) => (l.value && Array.isArray(l.value.items) ? l.value.items : []))
      .filter((it: Item) => it.t > from && it.t <= now)
      .sort((a: Item, b: Item) => a.t - b.t);

    for (const it of due) {
      for (const s of subs.filter((x) => x.user_id === user)) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: it.title, body: it.body, tag: it.tag }),
            { TTL: 600, urgency: 'high' },
          );
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          // The phone has dropped this subscription: forget it.
          if (code === 404 || code === 410) await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
          else console.error('push failed', code, e);
        }
      }
    }
    await sb.from('push_cursor').upsert({ user_id: user, sent_until: new Date(now).toISOString() });
  }
  return json({ sent });
});

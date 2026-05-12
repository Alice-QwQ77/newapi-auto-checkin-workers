import { app, runScheduled, type Bindings } from './app.ts';
import { createDenoKvD1 } from './deno-kv-d1.ts';
import { createPostgresD1 } from './postgres-d1.ts';

const env: Bindings = {
  DB: await createDatabase(),
  APP_NAME: Deno.env.get('APP_NAME') || 'New API Auto Check-in',
  ADMIN_USERNAME: Deno.env.get('ADMIN_USERNAME'),
  ADMIN_PASSWORD_HASH: Deno.env.get('ADMIN_PASSWORD_HASH'),
  ADMIN_PASSWORD: Deno.env.get('ADMIN_PASSWORD'),
  SESSION_TTL_SECONDS: Deno.env.get('SESSION_TTL_SECONDS'),
  LOG_RETENTION_DAYS: Deno.env.get('LOG_RETENTION_DAYS') || '7',
};

if (typeof Deno.cron === 'function') {
  Deno.cron('daily new-api check-in', '0 0 * * *', () => runScheduled(env));
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/__cron/checkin') {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (!isAuthorizedCronRequest(request)) {
      return new Response('Unauthorized', { status: 401 });
    }

    await runScheduled(env);
    return Response.json({ success: true });
  }

  return app.fetch(request, env);
});

async function createDatabase() {
  const backend = (Deno.env.get('DATABASE_BACKEND') || 'auto').toLowerCase();
  if (backend === 'postgres' || (backend === 'auto' && hasPostgresEnv())) {
    return createPostgresD1();
  }

  if (backend !== 'auto' && backend !== 'kv') {
    throw new Error('DATABASE_BACKEND must be one of: auto, postgres, kv');
  }

  const kv = await Deno.openKv();
  return createDenoKvD1(kv as Parameters<typeof createDenoKvD1>[0]);
}

function hasPostgresEnv() {
  return Boolean(
    Deno.env.get('DATABASE_URL') ||
      Deno.env.get('PGHOST') ||
      Deno.env.get('PGDATABASE') ||
      Deno.env.get('PGUSER'),
  );
}

function isAuthorizedCronRequest(request: Request) {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret) {
    return false;
  }

  const auth = request.headers.get('authorization') || '';
  return safeEqual(auth, `Bearer ${secret}`);
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

import type { D1DatabaseLike, D1PreparedStatementLike, RunRow, SiteRow } from './app.ts';

type KvKeyPart = string | number | bigint | boolean | Uint8Array;
type KvKey = readonly KvKeyPart[];
type KvEntry<T> = {
  key: KvKey;
  value: T | null;
  versionstamp: string | null;
};
type KvListSelector = {
  prefix: KvKey;
};
type KvSetOptions = {
  expireIn?: number;
};
type KvAtomicOperation = {
  check(check: { key: KvKey; versionstamp: string | null }): KvAtomicOperation;
  set(key: KvKey, value: unknown, options?: KvSetOptions): KvAtomicOperation;
  delete(key: KvKey): KvAtomicOperation;
  commit(): Promise<{ ok: boolean }>;
};
export type KvLike = {
  get<T = unknown>(key: KvKey): Promise<KvEntry<T>>;
  set(key: KvKey, value: unknown, options?: KvSetOptions): Promise<unknown>;
  delete(key: KvKey): Promise<void>;
  list<T = unknown>(selector: KvListSelector): AsyncIterable<KvEntry<T>>;
  atomic(): KvAtomicOperation;
};

type SessionRow = {
  id: string;
  username: string;
  created_at: string;
  expires_at: string;
};

type StatementResult = {
  meta: {
    last_row_id?: number;
  };
};

const SITE_COLUMNS =
  'id, name, base_url, access_token, user_id, enabled, notes, last_status, last_message, last_checkin_at, last_success_at, last_http_status, created_at, updated_at';

export function createDenoKvD1(kv: KvLike): D1DatabaseLike {
  return {
    prepare(query: string) {
      return new DenoKvStatement(kv, query);
    },
    async batch(statements: D1PreparedStatementLike[]) {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  };
}

class DenoKvStatement implements D1PreparedStatementLike {
  private readonly params: unknown[];

  constructor(
    private readonly kv: KvLike,
    private readonly query: string,
    params: unknown[] = [],
  ) {
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new DenoKvStatement(this.kv, this.query, values);
  }

  async run<T = unknown>(): Promise<StatementResult & T> {
    const sql = normalizeSql(this.query);
    const meta: StatementResult['meta'] = {};

    if (sql.startsWith('insert into sessions')) {
      const [id, username, createdAt, expiresAt] = this.params.map(String);
      await this.kv.set(sessionKey(id), { id, username, created_at: createdAt, expires_at: expiresAt });
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('delete from sessions where id = ?')) {
      await this.kv.delete(sessionKey(String(this.params[0])));
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('delete from sessions where expires_at <= ?')) {
      await deleteExpiredSessions(this.kv, String(this.params[0]));
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('insert into sites') && sql.includes('on conflict(name)')) {
      const site = await upsertImportedSite(this.kv, this.params);
      meta.last_row_id = site.id;
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('insert into sites')) {
      const site = await insertSite(this.kv, this.params);
      meta.last_row_id = site.id;
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('update sites set name = ?')) {
      await updateSite(this.kv, this.params);
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('delete from sites where id = ?')) {
      await deleteSite(this.kv, Number(this.params[0]));
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('insert into checkin_runs')) {
      const run = await insertRun(this.kv, this.params);
      meta.last_row_id = run.id;
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('update sites set last_status = ?')) {
      await updateSiteStatus(this.kv, this.params);
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('delete from checkin_runs where requested_at < ?')) {
      await deleteOldRuns(this.kv, String(this.params[0]));
      return { meta } as StatementResult & T;
    }

    throw new Error(`Deno KV adapter does not support run SQL: ${sql}`);
  }

  async all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> {
    const sql = normalizeSql(this.query);

    if (sql === `select ${SITE_COLUMNS} from sites order by id desc`) {
      return { results: (await listSites(this.kv, 'desc')) as T[] };
    }

    if (sql === 'select id from sites where enabled = 1 order by id asc') {
      const sites = (await listSites(this.kv, 'asc')).filter((site) => site.enabled === 1);
      return { results: sites.map((site) => ({ id: site.id })) as T[] };
    }

    if (sql.startsWith(`select ${SITE_COLUMNS} from sites where id in (`)) {
      const ids = this.params.map(Number);
      const sites = await Promise.all(ids.map((id) => getSite(this.kv, id)));
      return { results: sites.filter((site): site is SiteRow => Boolean(site)).sort((a, b) => a.id - b.id) as T[] };
    }

    if (sql.startsWith('select id, site_id, site_name, trigger_type, status, http_status')) {
      const limit = Number(this.params[0] || 100);
      return { results: (await listRuns(this.kv, limit)) as T[] };
    }

    throw new Error(`Deno KV adapter does not support all SQL: ${sql}`);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const sql = normalizeSql(this.query);

    if (sql.includes('from checkin_runs where requested_at >=')) {
      return (await getRecentRunStats(this.kv)) as T;
    }

    if (sql.includes('from sites') && sql.startsWith('select count(*) as count')) {
      const sites = await listSites(this.kv, 'asc');
      return {
        count: sites.length,
        enabledCount: sites.filter((site) => site.enabled === 1).length,
      } as T;
    }

    if (sql.startsWith('select status, site_name, requested_at, response_message from checkin_runs')) {
      const [latestRun] = await listRuns(this.kv, 1);
      if (!latestRun) {
        return null;
      }
      return {
        status: latestRun.status,
        site_name: latestRun.site_name,
        requested_at: latestRun.requested_at,
        response_message: latestRun.response_message,
      } as T;
    }

    if (sql.startsWith('select username, created_at from sessions')) {
      const id = String(this.params[0]);
      const now = String(this.params[1]);
      const entry = await this.kv.get<SessionRow>(sessionKey(id));
      if (!entry.value || entry.value.expires_at <= now) {
        return null;
      }
      return {
        username: entry.value.username,
        created_at: entry.value.created_at,
      } as T;
    }

    throw new Error(`Deno KV adapter does not support first SQL: ${sql}`);
  }
}

function normalizeSql(query: string) {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

function counterKey(name: string): KvKey {
  return ['meta', name];
}

function siteKey(id: number): KvKey {
  return ['sites', id];
}

function siteNameKey(name: string): KvKey {
  return ['site_names', name];
}

function runKey(id: number): KvKey {
  return ['runs', id];
}

function sessionKey(id: string): KvKey {
  return ['sessions', id];
}

async function nextId(kv: KvLike, name: string) {
  const key = counterKey(name);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entry = await kv.get<number>(key);
    const next = Number(entry.value || 0) + 1;
    const result = await kv.atomic().check({ key, versionstamp: entry.versionstamp }).set(key, next).commit();
    if (result.ok) {
      return next;
    }
  }
  throw new Error(`无法生成 ${name} ID`);
}

async function getSite(kv: KvLike, id: number) {
  return (await kv.get<SiteRow>(siteKey(id))).value;
}

async function listSites(kv: KvLike, direction: 'asc' | 'desc') {
  const sites: SiteRow[] = [];
  for await (const entry of kv.list<SiteRow>({ prefix: ['sites'] })) {
    if (entry.value) {
      sites.push(entry.value);
    }
  }
  return sites.sort((a, b) => (direction === 'asc' ? a.id - b.id : b.id - a.id));
}

async function insertSite(kv: KvLike, params: unknown[]) {
  const [name, baseUrl, accessToken, userId, enabled, notes, createdAt, updatedAt] = params;
  const siteName = String(name);
  const nameEntry = await kv.get<number>(siteNameKey(siteName));
  if (nameEntry.value !== null) {
    throw new Error('站点名称已存在');
  }

  const id = await nextId(kv, 'site_id');
  const site: SiteRow = {
    id,
    name: siteName,
    base_url: String(baseUrl),
    access_token: String(accessToken),
    user_id: Number(userId),
    enabled: Number(enabled),
    notes: String(notes || ''),
    last_status: 'idle',
    last_message: '',
    last_checkin_at: null,
    last_success_at: null,
    last_http_status: null,
    created_at: String(createdAt),
    updated_at: String(updatedAt),
  };

  const result = await kv
    .atomic()
    .check({ key: siteNameKey(siteName), versionstamp: nameEntry.versionstamp })
    .set(siteKey(id), site)
    .set(siteNameKey(siteName), id)
    .commit();
  if (!result.ok) {
    throw new Error('站点名称已存在');
  }
  return site;
}

async function updateSite(kv: KvLike, params: unknown[]) {
  const [name, baseUrl, accessToken, userId, enabled, notes, updatedAt, idValue] = params;
  const id = Number(idValue);
  const existing = await getSite(kv, id);
  if (!existing) {
    throw new Error('站点不存在');
  }

  const nextName = String(name);
  const nameEntry = await kv.get<number>(siteNameKey(nextName));
  if (nameEntry.value !== null && nameEntry.value !== id) {
    throw new Error('站点名称已存在');
  }

  const site: SiteRow = {
    ...existing,
    name: nextName,
    base_url: String(baseUrl),
    access_token: String(accessToken),
    user_id: Number(userId),
    enabled: Number(enabled),
    notes: String(notes || ''),
    updated_at: String(updatedAt),
  };

  let atomic = kv.atomic().set(siteKey(id), site).set(siteNameKey(nextName), id);
  if (existing.name !== nextName) {
    atomic = atomic.delete(siteNameKey(existing.name));
  }
  await atomic.commit();
}

async function deleteSite(kv: KvLike, id: number) {
  const existing = await getSite(kv, id);
  if (!existing) {
    return;
  }
  await kv.atomic().delete(siteKey(id)).delete(siteNameKey(existing.name)).commit();
}

async function upsertImportedSite(kv: KvLike, params: unknown[]) {
  const [name, baseUrl, accessToken, userId, enabled, notes, createdAt, updatedAt] = params;
  const existingId = (await kv.get<number>(siteNameKey(String(name)))).value;
  if (existingId !== null) {
    await updateSite(kv, [name, baseUrl, accessToken, userId, enabled, notes, updatedAt, existingId]);
    return (await getSite(kv, existingId)) as SiteRow;
  }
  return insertSite(kv, [name, baseUrl, accessToken, userId, enabled, notes, createdAt, updatedAt]);
}

async function insertRun(kv: KvLike, params: unknown[]) {
  const [
    siteId,
    siteName,
    triggerType,
    status,
    httpStatus,
    success,
    quotaAwarded,
    responseMessage,
    responseBody,
    requestedAt,
    completedAt,
  ] = params;
  const id = await nextId(kv, 'run_id');
  const run: RunRow = {
    id,
    site_id: Number(siteId),
    site_name: String(siteName),
    trigger_type: String(triggerType),
    status: String(status),
    http_status: httpStatus === null ? null : Number(httpStatus),
    success: Number(success),
    quota_awarded: nullableString(quotaAwarded),
    response_message: nullableString(responseMessage),
    response_body: nullableString(responseBody),
    requested_at: String(requestedAt),
    completed_at: nullableString(completedAt),
  };
  await kv.set(runKey(id), run);
  return run;
}

async function updateSiteStatus(kv: KvLike, params: unknown[]) {
  const [status, message, httpStatus, checkinAt, successAt, updatedAt, idValue] = params;
  const id = Number(idValue);
  const existing = await getSite(kv, id);
  if (!existing) {
    return;
  }
  const site: SiteRow = {
    ...existing,
    last_status: String(status),
    last_message: String(message),
    last_http_status: httpStatus === null ? null : Number(httpStatus),
    last_checkin_at: String(checkinAt),
    last_success_at: nullableString(successAt),
    updated_at: String(updatedAt),
  };
  await kv.set(siteKey(id), site);
}

async function listRuns(kv: KvLike, limit: number) {
  const runs: RunRow[] = [];
  for await (const entry of kv.list<RunRow>({ prefix: ['runs'] })) {
    if (entry.value) {
      runs.push(entry.value);
    }
  }
  return runs.sort((a, b) => b.id - a.id).slice(0, limit);
}

async function getRecentRunStats(kv: KvLike) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let count = 0;
  let successCount = 0;
  for await (const entry of kv.list<RunRow>({ prefix: ['runs'] })) {
    if (!entry.value || entry.value.requested_at < cutoff) {
      continue;
    }
    count += 1;
    successCount += entry.value.success === 1 ? 1 : 0;
  }
  return { count, successCount };
}

async function deleteOldRuns(kv: KvLike, cutoff: string) {
  for await (const entry of kv.list<RunRow>({ prefix: ['runs'] })) {
    if (entry.value && entry.value.requested_at < cutoff) {
      await kv.delete(entry.key);
    }
  }
}

async function deleteExpiredSessions(kv: KvLike, now: string) {
  for await (const entry of kv.list<SessionRow>({ prefix: ['sessions'] })) {
    if (entry.value && entry.value.expires_at <= now) {
      await kv.delete(entry.key);
    }
  }
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

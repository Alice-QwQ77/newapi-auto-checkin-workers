// @deno-types="npm:@types/pg"
import { Pool } from 'npm:pg';
import type { D1DatabaseLike, D1PreparedStatementLike } from './app.ts';

type PgPool = Pool;
type QueryResultRow = Record<string, unknown>;

type StatementResult = {
  meta: {
    last_row_id?: number;
  };
};

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  access_token TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT DEFAULT '',
  last_status TEXT DEFAULT 'idle',
  last_message TEXT DEFAULT '',
  last_checkin_at TEXT,
  last_success_at TEXT,
  last_http_status INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::TEXT),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::TEXT)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_name ON sites(name);

CREATE TABLE IF NOT EXISTS checkin_runs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  site_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  quota_awarded TEXT,
  response_message TEXT,
  response_body TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_requested_at ON checkin_runs(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_site_id ON checkin_runs(site_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`;

const SITE_COLUMNS =
  'id, name, base_url, access_token, user_id, enabled, notes, last_status, last_message, last_checkin_at, last_success_at, last_http_status, created_at, updated_at';

export async function createPostgresD1() {
  const pool = new Pool();
  await ensurePostgresSchema(pool);
  return createPostgresD1FromPool(pool);
}

export function createPostgresD1FromPool(pool: PgPool): D1DatabaseLike {
  return {
    prepare(query: string) {
      return new PostgresStatement(pool, query);
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

export async function ensurePostgresSchema(pool = new Pool()) {
  await pool.query(POSTGRES_SCHEMA);
}

class PostgresStatement implements D1PreparedStatementLike {
  private readonly params: unknown[];

  constructor(
    private readonly pool: PgPool,
    private readonly query: string,
    params: unknown[] = [],
  ) {
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new PostgresStatement(this.pool, this.query, values);
  }

  async run<T = unknown>(): Promise<StatementResult & T> {
    const sql = normalizeSql(this.query);
    const meta: StatementResult['meta'] = {};

    if (sql.startsWith('insert into sessions')) {
      await this.pool.query(
        'INSERT INTO sessions (id, username, created_at, expires_at) VALUES ($1, $2, $3, $4)',
        this.params,
      );
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('delete from sessions where id = ?')) {
      await this.pool.query('DELETE FROM sessions WHERE id = $1', this.params);
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('delete from sessions where expires_at <= ?')) {
      await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', this.params);
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('insert into sites') && sql.includes('on conflict(name)')) {
      const result = await this.pool.query(
        `
          INSERT INTO sites (name, base_url, access_token, user_id, enabled, notes, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT(name) DO UPDATE SET
            base_url = excluded.base_url,
            access_token = excluded.access_token,
            user_id = excluded.user_id,
            enabled = excluded.enabled,
            notes = excluded.notes,
            updated_at = excluded.updated_at
          RETURNING id
        `,
        this.params,
      );
      meta.last_row_id = toNumber(result.rows[0]?.id);
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('insert into sites')) {
      const result = await this.pool.query(
        `
          INSERT INTO sites (name, base_url, access_token, user_id, enabled, notes, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `,
        this.params,
      );
      meta.last_row_id = toNumber(result.rows[0]?.id);
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('update sites set name = ?')) {
      await this.pool.query(
        `
          UPDATE sites
          SET name = $1, base_url = $2, access_token = $3, user_id = $4, enabled = $5, notes = $6, updated_at = $7
          WHERE id = $8
        `,
        this.params,
      );
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('delete from sites where id = ?')) {
      await this.pool.query('DELETE FROM sites WHERE id = $1', this.params);
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('insert into checkin_runs')) {
      const result = await this.pool.query(
        `
          INSERT INTO checkin_runs
          (site_id, site_name, trigger_type, status, http_status, success, quota_awarded, response_message, response_body, requested_at, completed_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id
        `,
        this.params,
      );
      meta.last_row_id = toNumber(result.rows[0]?.id);
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('update sites set last_status = ?')) {
      await this.pool.query(
        `
          UPDATE sites
          SET last_status = $1, last_message = $2, last_http_status = $3, last_checkin_at = $4, last_success_at = $5, updated_at = $6
          WHERE id = $7
        `,
        this.params,
      );
      return { meta } as StatementResult & T;
    }

    if (sql.startsWith('delete from checkin_runs where requested_at < ?')) {
      await this.pool.query('DELETE FROM checkin_runs WHERE requested_at < $1', this.params);
      return { meta } as StatementResult & T;
    }

    throw new Error(`PostgreSQL adapter does not support run SQL: ${sql}`);
  }

  async all<T = QueryResultRow>(): Promise<{ results?: T[] }> {
    const sql = normalizeSql(this.query);

    if (sql === `select ${SITE_COLUMNS} from sites order by id desc`) {
      return { results: await this.queryRows<T>(`SELECT ${SITE_COLUMNS} FROM sites ORDER BY id DESC`) };
    }

    if (sql === 'select id from sites where enabled = 1 order by id asc') {
      return { results: await this.queryRows<T>('SELECT id FROM sites WHERE enabled = 1 ORDER BY id ASC') };
    }

    if (sql.startsWith(`select ${SITE_COLUMNS} from sites where id in (`)) {
      const placeholders = this.params.map((_, index) => `$${index + 1}`).join(', ');
      return {
        results: await this.queryRows<T>(
          `SELECT ${SITE_COLUMNS} FROM sites WHERE id IN (${placeholders}) ORDER BY id ASC`,
          this.params,
        ),
      };
    }

    if (sql.startsWith('select id, site_id, site_name, trigger_type, status, http_status')) {
      return {
        results: await this.queryRows<T>(
          `
            SELECT id, site_id, site_name, trigger_type, status, http_status, success, quota_awarded, response_message, response_body, requested_at, completed_at
            FROM checkin_runs
            ORDER BY id DESC
            LIMIT $1
          `,
          this.params,
        ),
      };
    }

    throw new Error(`PostgreSQL adapter does not support all SQL: ${sql}`);
  }

  async first<T = QueryResultRow>(): Promise<T | null> {
    const sql = normalizeSql(this.query);

    if (sql.includes('from checkin_runs where requested_at >=')) {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const result = await this.pool.query(
        `
          SELECT COUNT(*) AS count, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS "successCount"
          FROM checkin_runs
          WHERE requested_at >= $1
        `,
        [cutoff],
      );
      return normalizeCountRow(result.rows[0], ['count', 'successCount']) as T;
    }

    if (sql.includes('from sites') && sql.startsWith('select count(*) as count')) {
      const result = await this.pool.query(
        'SELECT COUNT(*) AS count, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS "enabledCount" FROM sites',
      );
      return normalizeCountRow(result.rows[0], ['count', 'enabledCount']) as T;
    }

    if (sql.startsWith('select status, site_name, requested_at, response_message from checkin_runs')) {
      const result = await this.pool.query(
        'SELECT status, site_name, requested_at, response_message FROM checkin_runs ORDER BY id DESC LIMIT 1',
      );
      return (result.rows[0] ?? null) as T | null;
    }

    if (sql.startsWith('select username, created_at from sessions')) {
      const result = await this.pool.query(
        `
          SELECT username, created_at
          FROM sessions
          WHERE id = $1 AND expires_at > $2
          LIMIT 1
        `,
        this.params,
      );
      return (result.rows[0] ?? null) as T | null;
    }

    throw new Error(`PostgreSQL adapter does not support first SQL: ${sql}`);
  }

  private async queryRows<T>(text: string, values = this.params) {
    const result = await this.pool.query(text, values);
    return result.rows as T[];
  }
}

function normalizeSql(query: string) {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeCountRow(row: QueryResultRow | undefined, keys: string[]) {
  const normalized: QueryResultRow = {};
  for (const key of keys) {
    normalized[key] = toNumber(row?.[key]) ?? 0;
  }
  return normalized;
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

import { serve } from '@hono/node-server';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { app, runScheduled } from './index.js';

type SqliteRunResult = {
  success: true;
  meta: {
    last_row_id: number;
    changes: number;
  };
};

type SqliteAllResult<T> = {
  results: T[];
  success: true;
};

class SqliteD1Database {
  private db: DatabaseSync;

  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  migrate(schemaPath: string) {
    const schema = readFileSync(schemaPath, 'utf8');
    this.db.exec(schema);
  }

  prepare(query: string) {
    return new SqliteD1PreparedStatement(this.db, query);
  }

  async batch(statements: SqliteD1PreparedStatement[]) {
    return statements.map((statement) => statement.runSync());
  }
}

class SqliteD1PreparedStatement {
  private params: SQLInputValue[] = [];

  constructor(
    private db: DatabaseSync,
    private query: string,
  ) {}

  bind(...params: SQLInputValue[]) {
    const next = new SqliteD1PreparedStatement(this.db, this.query);
    next.params = params;
    return next;
  }

  async all<T = unknown>(): Promise<SqliteAllResult<T>> {
    return {
      results: this.db.prepare(this.query).all(...this.params) as T[],
      success: true,
    };
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.params) as T | undefined) ?? null;
  }

  async run(): Promise<SqliteRunResult> {
    return this.runSync();
  }

  runSync(): SqliteRunResult {
    const result = this.db.prepare(this.query).run(...this.params);
    return {
      success: true,
      meta: {
        last_row_id: Number(result.lastInsertRowid ?? 0),
        changes: Number(result.changes),
      },
    };
  }
}

type ServerEnv = {
  DB: D1Database;
  APP_NAME: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_TTL_SECONDS?: string;
  LOG_RETENTION_DAYS?: string;
};

const port = Number(process.env.PORT || '3000');
const host = process.env.HOST || '0.0.0.0';
const databasePath = resolve(process.env.SQLITE_PATH || './data/newapi-checkin.sqlite');
const schemaPath = resolve(process.env.SCHEMA_PATH || './schema.sql');
const schedule = process.env.SCHEDULE_CRON || '0 8 * * *';

const sqlite = new SqliteD1Database(databasePath);
sqlite.migrate(schemaPath);

const env: ServerEnv = {
  DB: sqlite as unknown as D1Database,
  APP_NAME: process.env.APP_NAME || 'New API Auto Check-in',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
  SESSION_TTL_SECONDS: process.env.SESSION_TTL_SECONDS,
  LOG_RETENTION_DAYS: process.env.LOG_RETENTION_DAYS || '7',
};

serve(
  {
    fetch: (request) => app.fetch(request, env),
    hostname: host,
    port,
  },
  (info) => {
    console.log(`New API Auto Check-in server listening on http://${info.address}:${info.port}`);
    console.log(`SQLite database: ${databasePath}`);
    console.log(`Schedule: ${schedule}`);
  },
);

startDailySchedule(schedule, () => {
  runScheduled(env).catch((error: unknown) => {
    console.error('Scheduled check-in failed:', error);
  });
});

function startDailySchedule(expression: string, task: () => void) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Only 5-field daily cron expressions are supported, received: ${expression}`);
  }

  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    throw new Error(`Only fixed hour/minute cron expressions are supported, received: ${expression}`);
  }

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hour, minute, 0, 0);
    if (next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    const delay = next.getTime() - now.getTime();
    setTimeout(() => {
      task();
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

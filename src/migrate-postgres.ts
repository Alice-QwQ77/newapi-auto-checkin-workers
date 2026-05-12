import { ensurePostgresSchema } from './postgres-d1.ts';

await ensurePostgresSchema();
console.log('PostgreSQL schema is ready.');

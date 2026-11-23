/**
 * Tiny D1 helpers + Node sqlite stand-in for bridge adapter tests.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/** Wrap node:sqlite like Cloudflare D1's prepare/bind/first/run/batch API. */
export function createMemoryD1(migrationFiles = ['migrations/0001_bridge.sql']) {
  // Loaded lazily so the Worker bundle never has to resolve node:sqlite (tests only).
  const {DatabaseSync} = process.getBuiltinModule('node:sqlite');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of migrationFiles)
    sqlite.exec(readFileSync(join(root, file), 'utf8'));

  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          const runSync = () => sqlite.prepare(sql).run(...args);
          return {
            async run() {
              const result = runSync();
              return {meta: {changes: result.changes}};
            },
            async first() {
              return sqlite.prepare(sql).get(...args) || null;
            },
            async all() {
              return {results: sqlite.prepare(sql).all(...args)};
            }
          };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const stmt of statements) out.push(await stmt);
        sqlite.exec('COMMIT');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return {sqlite, db};
}

export async function d1First(db, sql, ...args) {
  return db.prepare(sql).bind(...args).first();
}

export async function d1Run(db, sql, ...args) {
  return db.prepare(sql).bind(...args).run();
}

export async function d1All(db, sql, ...args) {
  const result = await db.prepare(sql).bind(...args).all();
  return result.results || [];
}

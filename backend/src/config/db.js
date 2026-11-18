import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const dbType = process.env.DB_TYPE || (process.env.VERCEL ? 'mysql' : 'sqlite');

let sqliteDb = null;
let mysqlPool = null;
let postgresPool = null;

if (dbType === 'postgres' || dbType === 'postgresql') {
  if (!process.env.DATABASE_URL) {
    throw new Error('Missing PostgreSQL configuration: DATABASE_URL');
  }

  postgresPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
  });
  console.log('Configured PostgreSQL database pool');
} else if (dbType === 'mysql') {
  const requiredMySqlEnv = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const missingMySqlEnv = requiredMySqlEnv.filter(name => !process.env[name]);
  if (missingMySqlEnv.length) {
    throw new Error(`Missing MySQL configuration: ${missingMySqlEnv.join(', ')}`);
  }

  mysqlPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0,
    decimalNumbers: true,
    ssl: process.env.DB_SSL === 'true' ? {} : undefined
  });
  console.log('Configured MySQL database pool');
} else if (dbType === 'sqlite') {
  const dataDir = path.join(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const sqlitePath = path.join(dataDir, 'community_connect.sqlite');
  sqliteDb = new Database(sqlitePath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
} else {
  throw new Error(`Unsupported DB_TYPE: ${dbType}`);
}

/**
 * Universal query runner: executes queries transparently across SQLite or MySQL
 * Handles placeholder translation (? is standard for both)
 */
export async function query(sql, params = []) {
  if (postgresPool) {
    let index = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++index}`);
    const trimmed = pgSql.trim();
    let resultSql = pgSql;

    if (/^INSERT\s/i.test(trimmed) && !/\bRETURNING\b/i.test(trimmed)) {
      resultSql = `${pgSql.replace(/;\s*$/, '')} RETURNING id`;
    }
    if (/^UPDATE\s+notifications\s+SET\s+is_read\s*=\s*1/i.test(trimmed)) {
      resultSql = pgSql.replace(/\b=\s*1\b/i, '= TRUE');
    }

    const result = await postgresPool.query(resultSql, params);
    if (/^(SELECT|WITH|PRAGMA)\b/i.test(trimmed)) {
      return result.rows;
    }
    return {
      rows: result.rows,
      insertId: result.rows[0]?.id,
      affectedRows: result.rowCount
    };
  }

  if (mysqlPool) {
    const [rows] = await mysqlPool.execute(sql, params);
    return rows;
  }

  if (!sqliteDb) {
    throw new Error('No database connection is configured');
  }

  const trimmed = sql.trim().toUpperCase();
  try {
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
      const stmt = sqliteDb.prepare(sql);
      return stmt.all(...params);
    } else {
      const stmt = sqliteDb.prepare(sql);
      const info = stmt.run(...params);
      return {
        insertId: info.lastInsertRowid,
        affectedRows: info.changes
      };
    }
  } catch (err) {
    console.error('SQLite query error:', err.message, 'SQL:', sql, 'Params:', params);
    throw err;
  }
}

/**
 * Convenience method for single row return
 */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  if (Array.isArray(rows)) {
    return rows[0] || null;
  }
  return rows;
}

export { sqliteDb, mysqlPool, postgresPool };
export default { query, queryOne, sqliteDb, mysqlPool, postgresPool };

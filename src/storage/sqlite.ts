import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class SqliteStore {
  protected db: Database;

  constructor(dbPath: string) {
    const dir = join(dbPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.initSchema();
  }

  /** Override in subclasses to create tables. */
  protected initSchema(): void {
    // no-op by default
  }

  close(): void {
    this.db.close();
  }
}

import { SqliteStore } from './sqlite';

export interface ProjectRecord {
  root: string;
  name: string;
  language: string;
  packageManager: string;
  testCommand: string;
  detectedAt: string;
}

export class ProjectStore extends SqliteStore {
  protected override initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_info (
        root TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        language TEXT NOT NULL,
        package_manager TEXT NOT NULL,
        test_command TEXT NOT NULL,
        detected_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_project_info_detected_at ON project_info(detected_at DESC)
    `);
  }

  save(info: ProjectRecord): void {
    this.db.run(
      `INSERT OR REPLACE INTO project_info (root, name, language, package_manager, test_command, detected_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        info.root,
        info.name,
        info.language,
        info.packageManager,
        info.testCommand,
        info.detectedAt,
      ],
    );
  }

  get(root: string): ProjectRecord | null {
    const row = this.db
      .query('SELECT * FROM project_info WHERE root = ?')
      .get(root) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      root: row.root as string,
      name: row.name as string,
      language: row.language as string,
      packageManager: row.package_manager as string,
      testCommand: row.test_command as string,
      detectedAt: row.detected_at as string,
    };
  }

  getAll(): ProjectRecord[] {
    const rows = this.db
      .query('SELECT * FROM project_info ORDER BY detected_at DESC')
      .all() as Record<string, unknown>[];

    return rows.map((r) => ({
      root: r.root as string,
      name: r.name as string,
      language: r.language as string,
      packageManager: r.package_manager as string,
      testCommand: r.test_command as string,
      detectedAt: r.detected_at as string,
    }));
  }
}

import { SqliteStore } from './sqlite';
import type { CompletionUsage } from '../providers/types';
import type { SQLQueryBindings } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

export interface TaskLog {
  id: string;
  request: string;
  status: 'created' | 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt?: string;
  selectedFiles?: string[];
  planSummary?: string;
  changedFiles?: string[];
  testsRun?: string[];
  providersUsed?: string[];
  usage?: CompletionUsage;
  finalSummary?: string;
  errorMessage?: string;
}

export class TaskLogStore extends SqliteStore {
  protected override initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_logs (
        id TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        selected_files TEXT,
        plan_summary TEXT,
        changed_files TEXT,
        tests_run TEXT,
        providers_used TEXT,
        usage_json TEXT,
        final_summary TEXT,
        error_message TEXT
      )
    `);
  }

  createLog(request: string): TaskLog {
    const log: TaskLog = {
      id: `task_${randomUUID().slice(0, 8)}`,
      request,
      status: 'created',
      startedAt: new Date().toISOString(),
    };

    this.db.run(
      `INSERT INTO task_logs (id, request, status, started_at)
       VALUES (?, ?, ?, ?)`,
      [log.id, log.request, log.status, log.startedAt],
    );

    return log;
  }

  updateLog(id: string, updates: Partial<TaskLog>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    const mapping: Record<string, string> = {
      status: 'status',
      finishedAt: 'finished_at',
      selectedFiles: 'selected_files',
      planSummary: 'plan_summary',
      changedFiles: 'changed_files',
      testsRun: 'tests_run',
      providersUsed: 'providers_used',
      finalSummary: 'final_summary',
      errorMessage: 'error_message',
    };

    for (const [key, col] of Object.entries(mapping)) {
      const val = (updates as Record<string, unknown>)[key];
      if (val !== undefined) {
        fields.push(`${col} = ?`);
        values.push(Array.isArray(val) ? JSON.stringify(val) : String(val));
      }
    }

    if (updates.usage) {
      fields.push('usage_json = ?');
      values.push(JSON.stringify(updates.usage));
    }

    if (fields.length === 0) return;

    values.push(id);
    this.db.run(
      `UPDATE task_logs SET ${fields.join(', ')} WHERE id = ?`,
      values as SQLQueryBindings[],
    );
  }

  getLog(id: string): TaskLog | null {
    const row = this.db.query(
      `SELECT * FROM task_logs WHERE id = ?`,
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;
    return this.rowToLog(row);
  }

  getRecentLogs(limit = 10): TaskLog[] {
    const rows = this.db.query(
      `SELECT * FROM task_logs ORDER BY started_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToLog(r));
  }

  getLastLog(): TaskLog | null {
    const logs = this.getRecentLogs(1);
    return logs[0] ?? null;
  }

  private rowToLog(row: Record<string, unknown>): TaskLog {
    return {
      id: row.id as string,
      request: row.request as string,
      status: row.status as TaskLog['status'],
      startedAt: row.started_at as string,
      finishedAt: row.finished_at as string | undefined,
      selectedFiles: tryParseJsonArray(row.selected_files),
      planSummary: row.plan_summary as string | undefined,
      changedFiles: tryParseJsonArray(row.changed_files),
      testsRun: tryParseJsonArray(row.tests_run),
      providersUsed: tryParseJsonArray(row.providers_used),
      usage: tryParseJson(row.usage_json) as CompletionUsage | undefined,
      finalSummary: row.final_summary as string | undefined,
      errorMessage: row.error_message as string | undefined,
    };
  }
}

function tryParseJsonArray(val: unknown): string[] | undefined {
  if (typeof val !== 'string') return undefined;
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

function tryParseJson(val: unknown): Record<string, unknown> | undefined {
  if (typeof val !== 'string') return undefined;
  try {
    return JSON.parse(val) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

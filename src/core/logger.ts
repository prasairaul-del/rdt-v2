/**
 * Structured logger for the RDT v2 task runner.
 * Writes to stdout for live view and optionally to a file.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  taskId?: string;
  data?: Record<string, unknown>;
}

export class TaskLogger {
  private taskId?: string;
  private logFile?: string;
  private entries: LogEntry[] = [];
  private minLevel: LogLevel = 'info';

  private readonly LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

  constructor(taskId?: string, logFile?: string) {
    this.taskId = taskId;
    this.logFile = logFile;
  }

  setTaskId(taskId: string): void {
    this.taskId = taskId;
  }

  setLogFile(logFile: string): void {
    this.logFile = logFile;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
      data,
    };

    this.entries.push(entry);
    this.writeToConsole(entry);
    this.writeToFile(entry);
  }

  private shouldLog(level: LogLevel): boolean {
    return this.LEVEL_ORDER.indexOf(level) >= this.LEVEL_ORDER.indexOf(this.minLevel);
  }

  private writeToConsole(entry: LogEntry): void {
    const prefix = getLevelPrefix(entry.level);
    const taskTag = entry.taskId ? ` [${entry.taskId}]` : '';
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';

    switch (entry.level) {
      case 'error':
        console.error(`${prefix}${taskTag} ${entry.message}${dataStr}`);
        break;
      case 'warn':
        console.warn(`${prefix}${taskTag} ${entry.message}${dataStr}`);
        break;
      default:
        console.log(`${prefix}${taskTag} ${entry.message}${dataStr}`);
    }
  }

  private writeToFile(_entry: LogEntry): void {
    // File writing is handled by the task runner at completion
    // to avoid synchronous I/O during task execution
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  getRecentEntries(limit = 10): LogEntry[] {
    return this.entries.slice(-limit);
  }

  getErrors(): LogEntry[] {
    return this.entries.filter((e) => e.level === 'error');
  }

  formatAsText(): string {
    return this.entries
      .map((e) => {
        const prefix = getLevelPrefix(e.level);
        const taskTag = e.taskId ? ` [${e.taskId}]` : '';
        const dataStr = e.data ? ` ${JSON.stringify(e.data)}` : '';
        return `${e.timestamp}${prefix}${taskTag} ${e.message}${dataStr}`;
      })
      .join('\n');
  }

  clear(): void {
    this.entries = [];
  }
}

function getLevelPrefix(level: LogLevel): string {
  switch (level) {
    case 'debug': return '  DEBUG';
    case 'info':  return '   INFO';
    case 'warn':  return '   WARN';
    case 'error': return '  ERROR';
  }
}

export const defaultLogger = new TaskLogger();

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { loadConfig } from '../../config/load-config';
import { globalEventBus } from '../../core/events';
import { TaskLogStore } from '../../storage/task-log-store';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ReadinessLevel = 'ready' | 'partial' | 'needs_setup';

/**
 * Lightweight logger interface for the dashboard server.
 * Allows suppressing startup banners and errors during tests.
 */
export interface DashboardLogger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

type ReadinessPayload = {
  projectName: string;
  packageManager: string;
  scripts: {
    test: string | null;
    typecheck: string | null;
    lint: string | null;
    build: string | null;
  };
  providers: {
    openrouter: boolean;
    anthropic: boolean;
    gemini: boolean;
  };
  rules: {
    agents: boolean;
    knowledge: boolean;
    config: boolean;
  };
  level: ReadinessLevel;
};

function detectPackageManager(
  projectRoot: string,
  pkg?: { packageManager?: string },
): string {
  const fromField = pkg?.packageManager?.split('@')[0]?.trim();
  if (fromField) return fromField;

  if (
    existsSync(resolve(projectRoot, 'bun.lockb')) ||
    existsSync(resolve(projectRoot, 'bun.lock'))
  ) {
    return 'bun';
  }
  if (existsSync(resolve(projectRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(resolve(projectRoot, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(resolve(projectRoot, 'package-lock.json'))) {
    return 'npm';
  }

  return 'unknown';
}

function scriptCommand(
  packageManager: string,
  scriptName: string,
  scripts?: Record<string, string>,
): string | null {
  if (!scripts?.[scriptName]) return null;
  const runner =
    packageManager === 'bun'
      ? 'bun run'
      : packageManager === 'pnpm'
        ? 'pnpm run'
        : packageManager === 'yarn'
          ? 'yarn run'
          : 'npm run';
  return `${runner} ${scriptName}`;
}

function getReadiness(projectRoot: string): ReadinessPayload {
  let pkg: {
    name?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
  } | null = null;

  try {
    const raw = readFileSync(resolve(projectRoot, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw) as {
      name?: string;
      packageManager?: string;
      scripts?: Record<string, string>;
    };
  } catch {
    pkg = null;
  }

  const packageManager = detectPackageManager(projectRoot, pkg ?? undefined);
  const scripts = pkg?.scripts ?? {};
  const projectName =
    pkg?.name?.trim() || resolve(projectRoot).split(/[/\\]/).pop() || 'unknown';
  const readinessScripts = {
    test: scriptCommand(packageManager, 'test', scripts),
    typecheck: scriptCommand(packageManager, 'typecheck', scripts),
    lint: scriptCommand(packageManager, 'lint', scripts),
    build: scriptCommand(packageManager, 'build', scripts),
  };

  const providers = {
    openrouter: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    gemini: Boolean(process.env.GEMINI_API_KEY?.trim()),
  };

  const rules = {
    agents: existsSync(resolve(projectRoot, 'AGENTS.md')),
    knowledge: existsSync(resolve(projectRoot, 'knowledge.md')),
    config: existsSync(resolve(projectRoot, '.rdt', 'config.yaml')),
  };

  const scriptCount = Object.values(readinessScripts).filter(Boolean).length;
  const ruleCount = Object.values(rules).filter(Boolean).length;
  const providerCount = Object.values(providers).filter(Boolean).length;
  const usableLocalRoute =
    packageManager !== 'unknown' || scriptCount > 0 || ruleCount > 0;
  const setupCount = scriptCount + ruleCount + providerCount;

  let level: ReadinessLevel = 'needs_setup';
  if (providerCount > 0 && scriptCount >= 2 && ruleCount >= 2) {
    level = 'ready';
  } else if (usableLocalRoute || setupCount > 0) {
    level = 'partial';
  }

  return {
    projectName,
    packageManager,
    scripts: readinessScripts,
    providers,
    rules,
    level,
  };
}

export function createDashboardCommand(logger: DashboardLogger = console): Command {
  return new Command('dashboard')
    .description('Start the local dashboard Web UI server')
    .option(
      '-p, --port <number>',
      'Port to run the dashboard server on',
      '3000',
    )
    .option('--open-vscode', 'Open the dashboard inside VS Code simple browser')
    .action(async (options) => {
      const port = Number.parseInt(options.port, 10);
      const projectRoot = process.cwd();
      const dbPath = resolve(projectRoot, '.rdt', 'tasks.db');

      const logStore = new TaskLogStore(dbPath);
      const configResult = loadConfig(projectRoot);

      logger.log(
        `\n\x1b[32m[rdt-dashboard] Starting server on http://localhost:${port}\x1b[0m`,
      );
      logger.log(`[rdt-dashboard] Reading logs database from: ${dbPath}`);
      logger.log(
        `[rdt-dashboard] Monitoring events on workspace: ${projectRoot}\n`,
      );

      if (options.openVscode) {
        try {
          const { exec } = await import('node:child_process');
          exec(`code --command simpleBrowser.show http://localhost:${port}`);
          logger.log(
            `[rdt-dashboard] Triggered VS Code command: simpleBrowser.show http://localhost:${port}\n`,
          );
        } catch (err) {
          logger.warn(
            '[rdt-dashboard] Failed to launch VS Code command:',
            err,
          );
        }
      }

      // SSE clients for real-time streaming
      const clients = new Set<ReadableStreamDefaultController>();

      // Fix #4 — persist running state in DB, not just memory.
      // On startup, heal any stale 'running' tasks (crashed mid-run).
      const staleRunning = logStore
        .getRecentLogs(100)
        .filter((t) => t.status === 'running');
      for (const stale of staleRunning) {
        logStore.updateLog(stale.id, {
          status: 'failed',
          errorMessage: 'Server restarted while task was running',
        });
      }

      // Fix #14 — cancellation flag (per-task, keyed by id)
      let cancelRequested = false;
      let currentRunningTaskId: string | null = null;
      let processingQueue = false;

      async function processQueue(): Promise<void> {
        if (processingQueue) return;
        processingQueue = true;
        try {
          while (true) {
            const allRecent = logStore.getRecentLogs(100);
            const runningTask = allRecent.find((t) => t.status === 'running');
            if (runningTask) {
              break;
            }

            const queuedTasks = allRecent
              .filter((t) => t.status === 'queued')
              .reverse();
            if (queuedTasks.length === 0) {
              break;
            }

            const nextTask = queuedTasks[0];

            logStore.updateLog(nextTask.id, { status: 'running' });
            currentRunningTaskId = nextTask.id;
            cancelRequested = false;

            broadcastEvent({
              type: 'task:started',
              taskId: nextTask.id,
              timestamp: new Date().toISOString(),
              data: { running: true },
            });

            try {
              const { TaskRunner } = await import('../../core/task-runner');
              const currentConfig = loadConfig(projectRoot);
              const runner = new TaskRunner({
                projectRoot,
                rdtConfig: currentConfig.config,
                logStore,
                checkCancellation: () => cancelRequested,
              });
              await runner.run(nextTask.request);
            } catch (err) {
              logger.error(
                '[rdt-dashboard] Background task execution failed:',
                err,
              );
              logStore.updateLog(nextTask.id, {
                status: 'failed',
                errorMessage: err instanceof Error ? err.message : String(err),
              });
            } finally {
              const currentLog = logStore.getLog(nextTask.id);
              const finalStatus = cancelRequested
                ? 'cancelled'
                : currentLog?.status === 'failed'
                  ? 'failed'
                  : 'success';

              logStore.updateLog(nextTask.id, {
                status: finalStatus,
                finishedAt: new Date().toISOString(),
              });

              currentRunningTaskId = null;
              broadcastEvent({
                type: 'task:completed',
                taskId: nextTask.id,
                timestamp: new Date().toISOString(),
                data: { running: false, status: finalStatus },
              });
            }
          }
        } finally {
          processingQueue = false;
        }
      }

      // Process queue on server startup to handle any queued tasks
      processQueue();

      function broadcastEvent(event: Record<string, unknown>): void {
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of clients) {
          try {
            client.enqueue(new TextEncoder().encode(payload));
          } catch {
            clients.delete(client);
          }
        }
      }

      // Fix #13 — emit task:log events from the global event bus to SSE clients
      globalEventBus.onAny((event) => {
        broadcastEvent(event as unknown as Record<string, unknown>);
      });

      Bun.serve({
        port,
        async fetch(req) {
          const url = new URL(req.url);

          const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          };

          if (req.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
          }

          // SSE Events Stream
          if (url.pathname === '/api/events') {
            const stream = new ReadableStream({
              start(controller) {
                clients.add(controller);
              },
              cancel(controller) {
                clients.delete(controller as ReadableStreamDefaultController);
              },
            });
            return new Response(stream, {
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                ...corsHeaders,
              },
            });
          }

          // Fix #4 — API: Get Task Lock Status (reads from DB, not memory)
          if (url.pathname === '/api/status' && req.method === 'GET') {
            const allLogs = logStore.getRecentLogs(100);
            const running = allLogs.some((t) => t.status === 'running');
            const runningTask = allLogs.find((t) => t.status === 'running');
            const queueCount = allLogs.filter(
              (t) => t.status === 'queued',
            ).length;
            return new Response(
              JSON.stringify({
                running,
                currentTaskId: runningTask?.id ?? null,
                queueCount,
              }),
              {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              },
            );
          }

          // Fix #14 — API: Cancel Running Task
          if (
            url.pathname === '/api/tasks/current' &&
            req.method === 'DELETE'
          ) {
            if (!currentRunningTaskId) {
              return new Response(
                JSON.stringify({ error: 'No task is currently running.' }),
                {
                  status: 404,
                  headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                  },
                },
              );
            }
            cancelRequested = true;
            globalEventBus.emit('task:state_change', currentRunningTaskId, {
              from: 'running',
              to: 'cancelled',
            });
            return new Response(
              JSON.stringify({
                success: true,
                message: 'Cancellation requested.',
              }),
              {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              },
            );
          }

          // API: Trigger Task Execution (now Queued)
          if (url.pathname === '/api/tasks' && req.method === 'POST') {
            try {
              const body = (await req.json()) as { request?: string };
              const requestPrompt = body.request?.trim() ?? '';
              if (!requestPrompt) {
                return new Response(
                  JSON.stringify({
                    error: 'Task request prompt cannot be empty.',
                  }),
                  {
                    status: 400,
                    headers: {
                      'Content-Type': 'application/json',
                      ...corsHeaders,
                    },
                  },
                );
              }

              // Create log and insert in DB with status 'queued'
              const taskLog = logStore.createLog(requestPrompt);
              logStore.updateLog(taskLog.id, { status: 'queued' });

              broadcastEvent({
                type: 'task:queued',
                taskId: taskLog.id,
                timestamp: new Date().toISOString(),
                data: {
                  queueLength: logStore
                    .getRecentLogs(100)
                    .filter((t) => t.status === 'queued').length,
                },
              });

              // Process queue asynchronously
              processQueue();

              return new Response(
                JSON.stringify({
                  success: true,
                  taskId: taskLog.id,
                  status: 'queued',
                  message: 'Task queued successfully',
                }),
                {
                  headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                  },
                },
              );
            } catch (err) {
              return new Response(
                JSON.stringify({
                  error: `Invalid JSON request payload: ${String(err)}`,
                }),
                {
                  status: 400,
                  headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                  },
                },
              );
            }
          }

          // API: Get Recent Tasks
          if (url.pathname === '/api/tasks' && req.method === 'GET') {
            try {
              const logs = logStore.getRecentLogs(50);
              return new Response(JSON.stringify(logs), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            } catch (err) {
              return new Response(JSON.stringify({ error: String(err) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
          }

          // API: Get Specific Task Logs
          if (
            url.pathname.startsWith('/api/tasks/') &&
            url.pathname.endsWith('/logs') &&
            req.method === 'GET'
          ) {
            const id = url.pathname.slice(
              '/api/tasks/'.length,
              -'/logs'.length,
            );
            try {
              const logFilePath = resolve(
                projectRoot,
                '.rdt',
                'logs',
                `${id}.log`,
              );
              if (existsSync(logFilePath)) {
                const content = readFileSync(logFilePath, 'utf-8');
                return new Response(content, {
                  headers: { 'Content-Type': 'text/plain', ...corsHeaders },
                });
              }
              return new Response('No log file found for this task.', {
                status: 404,
                headers: { 'Content-Type': 'text/plain', ...corsHeaders },
              });
            } catch (err) {
              return new Response(String(err), {
                status: 500,
                headers: { 'Content-Type': 'text/plain', ...corsHeaders },
              });
            }
          }

          // API: Get Specific Task Details
          if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
            const id = url.pathname.slice('/api/tasks/'.length);
            try {
              const log = logStore.getLog(id);
              if (!log) {
                return new Response(
                  JSON.stringify({ error: 'Task not found' }),
                  {
                    status: 404,
                    headers: {
                      'Content-Type': 'application/json',
                      ...corsHeaders,
                    },
                  },
                );
              }
              return new Response(JSON.stringify(log), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            } catch (err) {
              return new Response(JSON.stringify({ error: String(err) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
          }

          // API: Save API Keys
          if (url.pathname === '/api/config/keys' && req.method === 'POST') {
            try {
              const body = (await req.json()) as Record<string, string>;
              const envPath = resolve(projectRoot, '.env');
              let envContent = '';
              let lines: string[] = [];
              if (existsSync(envPath)) {
                envContent = readFileSync(envPath, 'utf-8');
                lines = envContent.split(/\r?\n/);
              }

              const allowedKeys = [
                'OPENROUTER_API_KEY',
                'ANTHROPIC_API_KEY',
                'GEMINI_API_KEY',
              ];
              for (const [key, val] of Object.entries(body)) {
                if (!allowedKeys.includes(key)) continue;
                const idx = lines.findIndex((l) =>
                  l.trim().startsWith(`${key}=`),
                );
                if (idx !== -1) {
                  lines[idx] = `${key}=${val}`;
                } else {
                  lines.push(`${key}=${val}`);
                }
              }

              writeFileSync(envPath, lines.join('\n'), 'utf-8');
              return new Response(JSON.stringify({ success: true }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            } catch (err) {
              return new Response(JSON.stringify({ error: String(err) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
          }

          // API: Get Workspace Configuration
          if (url.pathname === '/api/config' && req.method === 'GET') {
            return new Response(JSON.stringify(configResult.config), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }

          // API: Get backend readiness summary for the dashboard
          if (url.pathname === '/api/readiness' && req.method === 'GET') {
            return new Response(JSON.stringify(getReadiness(projectRoot)), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }

          // Fix #7 — API: Get Live Provider Health (from provider state store)
          if (url.pathname === '/api/providers' && req.method === 'GET') {
            try {
              const { ProviderStateStore } = await import(
                '../../storage/provider-state-store'
              );
              const stateStore = new ProviderStateStore();
              const allModels = stateStore.getAll();
              const providersHealth = allModels.map((m) => ({
                providerId: m.providerId,
                modelId: m.modelId,
                enabled: m.enabled,
                quality: m.quality,
                cost: m.cost,
                cooldownUntil: m.cooldownUntil,
                lastErrorAt: m.lastErrorAt,
                lastErrorCode: m.lastErrorCode,
                requestsThisMinute: m.requestsThisMinute,
                requestsToday: m.requestsToday,
                status:
                  m.cooldownUntil && new Date(m.cooldownUntil) > new Date()
                    ? 'cooldown'
                    : m.lastErrorAt && !m.cooldownUntil
                      ? 'degraded'
                      : 'healthy',
              }));
              return new Response(JSON.stringify(providersHealth), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            } catch (err) {
              return new Response(JSON.stringify({ error: String(err) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
          }

          // API: Get Workspace Files
          if (url.pathname === '/api/files' && req.method === 'GET') {
            try {
              const { scanRepo } = await import(
                '../../project-context/repo-scanner'
              );
              const repoMap = scanRepo(projectRoot);
              const files = repoMap.entries
                .filter((e) => e.type === 'file')
                .map((e) => e.path);
              return new Response(JSON.stringify(files), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            } catch (err) {
              return new Response(JSON.stringify({ error: String(err) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
          }

          // Serve static assets from the dashboard folder
          if (url.pathname.startsWith('/ui/')) {
            const assetPath = resolve(
              __dirname,
              '../dashboard',
              `.${url.pathname}`,
            );
            if (existsSync(assetPath)) {
              try {
                const content = readFileSync(assetPath);
                let contentType = 'text/plain';
                if (url.pathname.endsWith('.css')) {
                  contentType = 'text/css';
                } else if (url.pathname.endsWith('.js')) {
                  contentType = 'application/javascript';
                } else if (url.pathname.endsWith('.svg')) {
                  contentType = 'image/svg+xml';
                }
                return new Response(content, {
                  headers: { 'Content-Type': contentType, ...corsHeaders },
                });
              } catch (err) {
                return new Response(`Error reading asset: ${String(err)}`, {
                  status: 500,
                });
              }
            }
          }

          // Serve HTML dashboard
          if (url.pathname === '/' || url.pathname === '/index.html') {
            const htmlPath = resolve(__dirname, '../dashboard/index.html');
            if (existsSync(htmlPath)) {
              try {
                const html = readFileSync(htmlPath, 'utf-8');
                return new Response(html, {
                  headers: { 'Content-Type': 'text/html' },
                });
              } catch (err) {
                return new Response(
                  `Error reading dashboard HTML: ${String(err)}`,
                  { status: 500 },
                );
              }
            }
            return new Response(
              `<h1>Dashboard Asset Not Found</h1><p>Expected path: ${htmlPath}</p>`,
              { status: 404 },
            );
          }

          return new Response('Not Found', { status: 404 });
        },
      });
    });
}

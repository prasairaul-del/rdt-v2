import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { TaskLogStore } from '../../storage/task-log-store';
import { loadConfig } from '../../config/load-config';
import { globalEventBus } from '../../core/events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createDashboardCommand(): Command {
  return new Command('dashboard')
    .description('Start the local dashboard Web UI server')
    .option('-p, --port <number>', 'Port to run the dashboard server on', '3000')
    .option('--open-vscode', 'Open the dashboard inside VS Code simple browser')
    .action(async (options) => {
      const port = parseInt(options.port, 10);
      const projectRoot = process.cwd();
      const dbPath = resolve(projectRoot, '.rdt', 'tasks.db');

      const logStore = new TaskLogStore(dbPath);
      const configResult = loadConfig(projectRoot);

      console.log(`\n\x1b[32m[rdt-dashboard] Starting server on http://localhost:${port}\x1b[0m`);
      console.log(`[rdt-dashboard] Reading logs database from: ${dbPath}`);
      console.log(`[rdt-dashboard] Monitoring events on workspace: ${projectRoot}\n`);

      if (options.openVscode) {
        try {
          const { exec } = await import('node:child_process');
          exec(`code --command simpleBrowser.show http://localhost:${port}`);
          console.log(`[rdt-dashboard] Triggered VS Code command: simpleBrowser.show http://localhost:${port}\n`);
        } catch (err) {
          console.warn('[rdt-dashboard] Failed to launch VS Code command:', err);
        }
      }

      // Keep a list of SSE client connections to broadcast events
      const clients = new Set<ReadableStreamDefaultController>();
      let isTaskRunning = false;

      // Listen to the globalEventBus and stream to SSE clients in real-time
      globalEventBus.onAny((event) => {
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of clients) {
          try {
            client.enqueue(new TextEncoder().encode(payload));
          } catch {
            clients.delete(client);
          }
        }
      });

      Bun.serve({
        port,
        async fetch(req) {
          const url = new URL(req.url);

          // CORS Headers for API debugging
          const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
                clients.delete(controller as any);
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

          // API: Get Task Lock Status
          if (url.pathname === '/api/status' && req.method === 'GET') {
            return new Response(JSON.stringify({ running: isTaskRunning }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }

          // API: Trigger Task Execution
          if (url.pathname === '/api/tasks' && req.method === 'POST') {
            if (isTaskRunning) {
              return new Response(JSON.stringify({ error: 'A task is already running in this workspace.' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }

            try {
              const body = await req.json() as { request?: string };
              const requestPrompt = body.request?.trim() ?? '';
              if (!requestPrompt) {
                return new Response(JSON.stringify({ error: 'Task request prompt cannot be empty.' }), {
                  status: 400,
                  headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
              }

              // Lock the state machine and run task in background
              isTaskRunning = true;

              // Broadcast task:started to UI
              const startEvent = {
                type: 'task:started',
                taskId: 'system',
                timestamp: new Date().toISOString(),
                data: { running: true }
              };
              const startPayload = `data: ${JSON.stringify(startEvent)}\n\n`;
              for (const client of clients) {
                try {
                  client.enqueue(new TextEncoder().encode(startPayload));
                } catch {
                  clients.delete(client);
                }
              }

              // Asynchronous background run
              (async () => {
                try {
                  const { TaskRunner } = await import('../../core/task-runner');
                  const currentConfig = loadConfig(projectRoot);
                  const runner = new TaskRunner({
                    projectRoot,
                    rdtConfig: currentConfig.config,
                  });
                  await runner.run(requestPrompt);
                } catch (err) {
                  console.error('[rdt-dashboard] Background task execution failed:', err);
                } finally {
                  isTaskRunning = false;

                  // Broadcast task:completed to UI
                  const completeEvent = {
                    type: 'task:completed',
                    taskId: 'system',
                    timestamp: new Date().toISOString(),
                    data: { running: false }
                  };
                  const completePayload = `data: ${JSON.stringify(completeEvent)}\n\n`;
                  for (const client of clients) {
                    try {
                      client.enqueue(new TextEncoder().encode(completePayload));
                    } catch {
                      clients.delete(client);
                    }
                  }
                }
              })();

              return new Response(JSON.stringify({ success: true, message: 'Task started successfully' }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });

            } catch (err) {
              return new Response(JSON.stringify({ error: 'Invalid JSON request payload: ' + String(err) }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
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

          // API: Get Specific Task Details
          if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
            const id = url.pathname.slice('/api/tasks/'.length);
            try {
              const log = logStore.getLog(id);
              if (!log) {
                return new Response(JSON.stringify({ error: 'Task not found' }), {
                  status: 404,
                  headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
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

          // API: Get Workspace Configuration
          if (url.pathname === '/api/config' && req.method === 'GET') {
            return new Response(JSON.stringify(configResult.config), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }

          // API: Get Workspace Files
          if (url.pathname === '/api/files' && req.method === 'GET') {
            try {
              const { scanRepo } = await import('../../project-context/repo-scanner');
              const repoMap = scanRepo(projectRoot);
              const files = repoMap.entries.filter(e => e.type === 'file').map(e => e.path);
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
                return new Response(`Error reading dashboard HTML: ${String(err)}`, { status: 500 });
              }
            }
            return new Response(`<h1>Dashboard Asset Not Found</h1><p>Expected path: ${htmlPath}</p>`, { status: 404 });
          }

          return new Response('Not Found', { status: 404 });
        },
      });
    });
}

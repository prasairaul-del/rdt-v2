import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('[RDT-v2 Extension] Active');

  const provider = new RdtWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      RdtWebviewProvider.viewType,
      provider,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rdt-v2.openDashboard', () => {
      vscode.commands.executeCommand(
        'workbench.view.extension.rdt-sidebar-container',
      );
    }),
  );
}

class RdtWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'rdt-webview-panel';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewContext,
    _token: vscode.CancellationToken,
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    const config = vscode.workspace.getConfiguration('rdt-v2');
    const port = config.get<number>('dashboardPort') ?? 3000;

    webviewView.webview.html = this._getHtmlForWebview(port);
  }

  private _getHtmlForWebview(port: number) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RDT-v2 Dashboard</title>
    <style>
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: #0b0f19;
            color: #f8fafc;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        #iframe-container {
            width: 100%;
            height: 100%;
            display: none;
            border: none;
        }
        iframe {
            width: 100%;
            height: 100%;
            border: none;
        }
        .fallback-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            padding: 1.5rem;
            text-align: center;
            box-sizing: border-box;
        }
        .fallback-card {
            background: rgba(30, 41, 59, 0.4);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            padding: 1.5rem;
            width: 100%;
            max-width: 320px;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px);
        }
        h3 {
            margin-top: 0;
            color: #e2e8f0;
            font-size: 1.1rem;
        }
        p {
            color: #94a3b8;
            font-size: 0.85rem;
            line-height: 1.4;
            margin-bottom: 1.25rem;
        }
        .port-input-row {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }
        input {
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #f8fafc;
            border-radius: 6px;
            padding: 0.45rem 0.75rem;
            font-size: 0.85rem;
            width: 80px;
            text-align: center;
        }
        button {
            background: #2563eb;
            color: white;
            border: none;
            border-radius: 6px;
            padding: 0.45rem 1rem;
            font-size: 0.85rem;
            cursor: pointer;
            font-weight: 500;
            flex: 1;
            transition: background 0.2s;
        }
        button:hover {
            background: #1d4ed8;
        }
        .command-box {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 4px;
            padding: 0.5rem;
            font-family: monospace;
            font-size: 0.8rem;
            color: #38bdf8;
            margin-top: 0.5rem;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div id="iframe-container">
        <iframe id="dashboard-iframe" src=""></iframe>
    </div>
    <div id="fallback-panel" class="fallback-container" style="display: none;">
        <div class="fallback-card">
            <h3>Dashboard Offline</h3>
            <p>Could not connect to the local RDT-v2 server on port <span id="current-port"></span>.</p>
            <div class="port-input-row">
                <input type="number" id="port-input" value="" />
                <button onclick="retryConnection()">Connect</button>
            </div>
            <p style="font-size: 0.75rem; margin-bottom: 0;">Start it from your terminal using:</p>
            <div class="command-box">rdt dashboard --port <span id="cmd-port"></span></div>
        </div>
    </div>

    <script>
        let currentPort = ${port};
        document.getElementById('current-port').innerText = currentPort;
        document.getElementById('cmd-port').innerText = currentPort;
        document.getElementById('port-input').value = currentPort;

        async function checkConnection(port) {
            try {
                const res = await fetch(\`http://localhost:\${port}/api/status\`, { signal: AbortSignal.timeout(2000) });
                return res.ok;
            } catch {
                return false;
            }
        }

        async function tryConnect(port) {
            const isOnline = await checkConnection(port);
            if (isOnline) {
                document.getElementById('fallback-panel').style.display = 'none';
                const iframe = document.getElementById('dashboard-iframe');
                iframe.src = \`http://localhost:\${port}\`;
                document.getElementById('iframe-container').style.display = 'block';
            } else {
                document.getElementById('iframe-container').style.display = 'none';
                document.getElementById('current-port').innerText = port;
                document.getElementById('cmd-port').innerText = port;
                document.getElementById('fallback-panel').style.display = 'flex';
            }
        }

        function retryConnection() {
            const port = parseInt(document.getElementById('port-input').value, 10) || 3000;
            currentPort = port;
            tryConnect(port);
        }

        // Initial connect attempt
        tryConnect(currentPort);
    </script>
</body>
</html>`;
  }
}

export function deactivate() {}

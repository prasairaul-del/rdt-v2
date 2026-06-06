import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('[RDT-v2 Extension] Active');

  const provider = new RdtWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RdtWebviewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rdt-v2.openDashboard', () => {
      vscode.commands.executeCommand('workbench.view.extension.rdt-sidebar-container');
    })
  );
}

class RdtWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'rdt-webview-panel';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    // Load localhost dashboard dynamically inside WebView iframe
    webviewView.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RDT-v2 Dashboard</title>
    <style>
        html, body, iframe {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            border: none;
            overflow: hidden;
            background-color: transparent;
        }
    </style>
</head>
<body>
    <iframe src="http://localhost:3000"></iframe>
</body>
</html>`;
  }
}

export function deactivate() {}

import * as vscode from 'vscode';

export interface LivePreviewSnapshot {
  readonly imageDataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly source: string;
  readonly projectPath: string;
  readonly xamlPath: string;
}

interface PreviewResultSuccess {
  readonly ok: true;
  readonly snapshot: LivePreviewSnapshot;
}

interface PreviewResultError {
  readonly ok: false;
  readonly message: string;
}

type PreviewResult = PreviewResultSuccess | PreviewResultError;
type SnapshotProvider = () => Promise<PreviewResult>;

export class WpfLivePreviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private inFlight = false;

  constructor(private readonly provideSnapshot: SnapshotProvider) { }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'wpfLivePreview',
      'WPF Live Preview',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
    };
    panel.webview.html = this.getHtml(panel.webview);

    panel.webview.onDidReceiveMessage(msg => {
      if (msg?.type === 'refresh') {
        void this.refresh('manual');
      }
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    void this.refresh('initial');
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  async refresh(_reason: 'initial' | 'manual' | 'hotReload' | 'sessionStart'): Promise<void> {
    if (!this.panel || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      this.panel.webview.postMessage({ type: 'loading' });
      const result = await this.provideSnapshot();
      if (result.ok) {
        this.panel.webview.postMessage({
          type: 'snapshot',
          imageDataUrl: result.snapshot.imageDataUrl,
          width: result.snapshot.width,
          height: result.snapshot.height,
          source: result.snapshot.source,
          projectPath: result.snapshot.projectPath,
          xamlPath: result.snapshot.xamlPath,
          at: new Date().toLocaleTimeString(),
        });
      } else {
        this.panel.webview.postMessage({
          type: 'error',
          message: result.message,
        });
      }
    } finally {
      this.inFlight = false;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 8px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      align-items: center;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .meta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.4;
      margin-bottom: 8px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .panel {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      min-height: 120px;
      overflow: hidden;
    }
    .state {
      padding: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    img {
      display: block;
      width: 100%;
      height: auto;
      image-rendering: auto;
      background: var(--vscode-editor-background);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="refresh">Refresh</button>
  </div>
  <div class="meta" id="meta">No preview yet.</div>
  <div class="panel" id="panel">
    <div class="state" id="state">Waiting for runtime snapshot…</div>
    <img id="preview" alt="Live WPF preview" style="display:none;" />
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const refresh = document.getElementById('refresh');
    const meta = document.getElementById('meta');
    const state = document.getElementById('state');
    const preview = document.getElementById('preview');

    refresh.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', event => {
      const msg = event.data || {};
      if (msg.type === 'loading') {
        state.style.display = 'block';
        state.textContent = 'Refreshing preview…';
        return;
      }

      if (msg.type === 'error') {
        preview.style.display = 'none';
        state.style.display = 'block';
        state.textContent = msg.message || 'Could not capture preview.';
        return;
      }

      if (msg.type === 'snapshot') {
        preview.src = msg.imageDataUrl;
        preview.style.display = 'block';
        state.style.display = 'none';
        meta.textContent =
          'Source: ' + (msg.source || 'runtime') + '\\n' +
          'Size: ' + msg.width + 'x' + msg.height + '\\n' +
          'Project: ' + (msg.projectPath || '') + '\\n' +
          'XAML: ' + (msg.xamlPath || '') + '\\n' +
          'Updated: ' + (msg.at || '');
      }
    });
  </script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

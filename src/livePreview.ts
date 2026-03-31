import * as vscode from 'vscode';

export interface LivePreviewSnapshot {
  readonly imageDataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly source: string;
  readonly projectPath: string;
  readonly xamlPath: string;
}

export interface LivePreviewHit {
  readonly typeName: string;
  readonly elementName: string;
  readonly boundsX: number;
  readonly boundsY: number;
  readonly boundsWidth: number;
  readonly boundsHeight: number;
  readonly rootWidth: number;
  readonly rootHeight: number;
}

export interface LivePreviewProperties {
  readonly typeName: string;
  readonly elementName: string;
  readonly text: string;
  readonly background: string;
  readonly foreground: string;
  readonly width: string;
  readonly height: string;
  readonly actualWidth: string;
  readonly actualHeight: string;
  readonly margin: string;
  readonly horizontalAlignment: string;
  readonly verticalAlignment: string;
  readonly isEnabled: string;
  readonly visibility: string;
  readonly canEditText: boolean;
  readonly canEditBackground: boolean;
  readonly canEditForeground: boolean;
}

interface PreviewResultSuccess {
  readonly ok: true;
  readonly snapshot: LivePreviewSnapshot;
}

interface PreviewResultError {
  readonly ok: false;
  readonly message: string;
}

interface HitTestResultSuccess {
  readonly ok: true;
  readonly hit: LivePreviewHit;
}

interface HitTestResultError {
  readonly ok: false;
  readonly message: string;
}

interface InspectResultSuccess {
  readonly ok: true;
  readonly properties: LivePreviewProperties;
}

interface InspectResultError {
  readonly ok: false;
  readonly message: string;
}

interface ApplyResultSuccess {
  readonly ok: true;
  readonly message: string;
}

interface ApplyResultError {
  readonly ok: false;
  readonly message: string;
}

type PreviewResult = PreviewResultSuccess | PreviewResultError;
type SnapshotProvider = () => Promise<PreviewResult>;
type HitTestResult = HitTestResultSuccess | HitTestResultError;
type HitTestProvider = (xNorm: number, yNorm: number) => Promise<HitTestResult>;
type FindProvider = (elementName: string, typeName: string) => Promise<HitTestResult>;
type InspectResult = InspectResultSuccess | InspectResultError;
type InspectProvider = (elementName: string, typeName: string) => Promise<InspectResult>;
type ApplyResult = ApplyResultSuccess | ApplyResultError;
type ApplyProvider = (
  elementName: string,
  typeName: string,
  property: 'Text' | 'Background' | 'Foreground',
  value: string,
  autoPush: boolean
) => Promise<ApplyResult>;
type InsertProvider = (
  xNorm: number,
  yNorm: number,
  item: LivePreviewToolboxItem,
  autoPush: boolean
) => Promise<ApplyResult>;

interface LivePreviewToolboxItem {
  readonly kind: 'wpfToolboxItem';
  readonly displayName: string;
  readonly typeName: string;
  readonly xmlNamespace?: string;
  readonly clrNamespace?: string;
  readonly assemblyName?: string;
  readonly prefixHint?: string;
  readonly requiresPrefix: boolean;
  readonly defaultSnippet: string;
}

export class WpfLivePreviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private inFlight = false;

  constructor(
    private readonly provideSnapshot: SnapshotProvider,
    private readonly provideHitTest: HitTestProvider,
    private readonly provideFind: FindProvider,
    private readonly provideInspect: InspectProvider,
    private readonly provideApply: ApplyProvider,
    private readonly provideInsert: InsertProvider,
    private readonly getDefaultAutoPush: () => boolean
  ) { }

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
    panel.webview.html = this.getHtml(panel.webview, this.getDefaultAutoPush());

    panel.webview.onDidReceiveMessage(msg => {
      if (msg?.type === 'refresh') {
        void this.refresh('manual');
        return;
      }

      if (msg?.type === 'hitTest' && typeof msg.xNorm === 'number' && typeof msg.yNorm === 'number') {
        void this.hitTest(msg.xNorm, msg.yNorm);
        return;
      }

      if (
        msg?.type === 'applyProperty' &&
        typeof msg.elementName === 'string' &&
        typeof msg.typeName === 'string' &&
        (msg.property === 'Text' || msg.property === 'Background') &&
        typeof msg.value === 'string' &&
        typeof msg.autoPush === 'boolean'
      ) {
        void this.applyProperty(msg.elementName, msg.typeName, msg.property, msg.value, msg.autoPush);
        return;
      }

      if (
        msg?.type === 'applyProperty' &&
        typeof msg.elementName === 'string' &&
        typeof msg.typeName === 'string' &&
        msg.property === 'Foreground' &&
        typeof msg.value === 'string' &&
        typeof msg.autoPush === 'boolean'
      ) {
        void this.applyProperty(msg.elementName, msg.typeName, msg.property, msg.value, msg.autoPush);
        return;
      }

      if (
        msg?.type === 'dropToolboxItem' &&
        typeof msg.xNorm === 'number' &&
        typeof msg.yNorm === 'number' &&
        msg.item &&
        isLivePreviewToolboxItem(msg.item) &&
        typeof msg.autoPush === 'boolean'
      ) {
        void this.insertToolboxItem(msg.xNorm, msg.yNorm, msg.item, msg.autoPush);
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

  async syncSelection(elementName: string, typeName: string): Promise<void> {
    if (!this.panel) {
      return;
    }

    const result = await this.provideFind(elementName, typeName);
    if (result.ok) {
      await this.postSelection(result.hit);
      return;
    }

    this.panel.webview.postMessage({
      type: 'hitTestError',
      message: result.message,
    });
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

  private async hitTest(xNorm: number, yNorm: number): Promise<void> {
    if (!this.panel) {
      return;
    }

    const result = await this.provideHitTest(xNorm, yNorm);
    if (result.ok) {
      await this.postSelection(result.hit);
    } else {
      this.panel.webview.postMessage({
        type: 'hitTestError',
        message: result.message,
      });
    }
  }

  private async postSelection(hit: LivePreviewHit): Promise<void> {
    if (!this.panel) {
      return;
    }

    const inspect = await this.provideInspect(hit.elementName, hit.typeName);
    this.panel.webview.postMessage({
      type: 'hitTestResult',
      hit,
      properties: inspect.ok ? inspect.properties : undefined,
      propertiesError: inspect.ok ? undefined : inspect.message,
    });
  }

  private async applyProperty(
    elementName: string,
    typeName: string,
    property: 'Text' | 'Background' | 'Foreground',
    value: string,
    autoPush: boolean
  ): Promise<void> {
    if (!this.panel) {
      return;
    }

    const result = await this.provideApply(elementName, typeName, property, value, autoPush);
    this.panel.webview.postMessage({
      type: 'applyResult',
      ok: result.ok,
      message: result.message,
    });

    if (result.ok) {
      await this.refresh('manual');
      await this.syncSelection(elementName, typeName);
    }
  }

  private async insertToolboxItem(
    xNorm: number,
    yNorm: number,
    item: LivePreviewToolboxItem,
    autoPush: boolean
  ): Promise<void> {
    if (!this.panel) {
      return;
    }

    const result = await this.provideInsert(xNorm, yNorm, item, autoPush);
    this.panel.webview.postMessage({
      type: 'insertResult',
      ok: result.ok,
      message: result.message,
    });

    if (result.ok) {
      await this.refresh('manual');
    }
  }

  private getHtml(webview: vscode.Webview, defaultAutoPush: boolean): string {
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
      position: relative;
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
      cursor: crosshair;
    }
    .selection {
      margin: 8px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .properties {
      margin: 8px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 6px 8px;
      background: var(--vscode-editor-background);
    }
    .editors {
      margin-top: 6px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      align-items: center;
    }
    .editors input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 11px;
    }
    .editors button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    .hint {
      margin-top: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      min-height: 16px;
    }
    .options {
      margin-top: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hit-overlay {
      position: absolute;
      border: 1px solid var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
      pointer-events: none;
      display: none;
      box-sizing: border-box;
    }
    .drop-overlay {
      position: absolute;
      inset: 0;
      border: 2px dashed var(--vscode-focusBorder);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
      color: var(--vscode-foreground);
      font-size: 12px;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      text-align: center;
      padding: 8px;
      box-sizing: border-box;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="refresh">Refresh</button>
  </div>
  <div class="meta" id="meta">No preview yet.</div>
  <div class="selection" id="selection">Selection: none</div>
  <div class="properties" id="properties">Properties: none</div>
  <div class="editors">
    <input id="textValue" type="text" placeholder="Text/Content value" />
    <button id="applyText">Apply Text</button>
    <input id="backgroundValue" type="text" placeholder="Background brush, e.g. #FF007ACC" />
    <button id="applyBackground">Apply Background</button>
    <input id="foregroundValue" type="text" placeholder="Foreground brush, e.g. White" />
    <button id="applyForeground">Apply Foreground</button>
  </div>
  <label class="options">
    <input id="autoPush" type="checkbox" />
    <span>Auto Push Hot Reload</span>
  </label>
  <div class="hint" id="applyHint"></div>
  <div class="panel" id="panel">
    <div class="state" id="state">Waiting for runtime snapshot…</div>
    <img id="preview" alt="Live WPF preview" style="display:none;" />
    <div class="hit-overlay" id="hitOverlay"></div>
    <div class="drop-overlay" id="dropOverlay">Drop toolbox item to insert into XAML</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const TOOLBOX_MIME = 'application/vnd.vscode-wpf.toolbox-item+json';
    const refresh = document.getElementById('refresh');
    const meta = document.getElementById('meta');
    const selection = document.getElementById('selection');
    const properties = document.getElementById('properties');
    const textValue = document.getElementById('textValue');
    const backgroundValue = document.getElementById('backgroundValue');
    const foregroundValue = document.getElementById('foregroundValue');
    const applyText = document.getElementById('applyText');
    const applyBackground = document.getElementById('applyBackground');
    const applyForeground = document.getElementById('applyForeground');
    const autoPush = document.getElementById('autoPush');
    const applyHint = document.getElementById('applyHint');
    const state = document.getElementById('state');
    const preview = document.getElementById('preview');
    const panel = document.getElementById('panel');
    const hitOverlay = document.getElementById('hitOverlay');
    const dropOverlay = document.getElementById('dropOverlay');
    let rootWidth = 0;
    let rootHeight = 0;
    let currentSelection = null;
    let dragDepth = 0;
    let currentCapabilities = {
      canEditText: false,
      canEditBackground: false,
      canEditForeground: false,
    };
    const savedState = vscode.getState() || {};
    if (typeof savedState.autoPush === 'boolean') {
      autoPush.checked = !!savedState.autoPush;
    } else {
      autoPush.checked = ${defaultAutoPush ? 'true' : 'false'};
    }

    refresh.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    autoPush.addEventListener('change', () => {
      vscode.setState({ autoPush: !!autoPush.checked });
    });

    preview.addEventListener('click', event => {
      const rect = preview.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return;
      }

      const xNorm = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const yNorm = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      vscode.postMessage({ type: 'hitTest', xNorm, yNorm });
    });

    function readDroppedToolboxItem(dataTransfer) {
      if (!dataTransfer) {
        return null;
      }

      const typed = dataTransfer.getData(TOOLBOX_MIME);
      if (typed) {
        try {
          const parsed = JSON.parse(typed);
          if (parsed && parsed.kind === 'wpfToolboxItem' && typeof parsed.defaultSnippet === 'string') {
            return parsed;
          }
        } catch {
          // ignore parse errors
        }
      }

      const plain = (dataTransfer.getData('text/plain') || '').trim();
      if (plain.startsWith('<') && plain.endsWith('>')) {
        return {
          kind: 'wpfToolboxItem',
          displayName: 'Snippet',
          typeName: 'Snippet',
          requiresPrefix: false,
          defaultSnippet: plain,
        };
      }

      return null;
    }

    function hasSupportedDropPayload(dataTransfer) {
      if (!dataTransfer) {
        return false;
      }

      const types = Array.from(dataTransfer.types || []);
      return types.includes(TOOLBOX_MIME) || types.includes('text/plain');
    }

    function postDrop(event) {
      if (!preview || preview.style.display === 'none') {
        applyHint.textContent = 'Preview is not ready yet.';
        return;
      }

      const item = readDroppedToolboxItem(event.dataTransfer);
      if (!item) {
        applyHint.textContent = 'Drop a WPF toolbox item or XAML snippet.';
        return;
      }

      const rect = preview.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        applyHint.textContent = 'Preview is not ready yet.';
        return;
      }

      const xNorm = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const yNorm = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      vscode.postMessage({
        type: 'dropToolboxItem',
        xNorm,
        yNorm,
        item,
        autoPush: !!autoPush.checked,
      });
    }

    function showDropOverlay(show) {
      dropOverlay.style.display = show ? 'flex' : 'none';
    }

    function handleDragEnter(event) {
      if (!hasSupportedDropPayload(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      dragDepth += 1;
      showDropOverlay(true);
    }

    function handleDragLeave(event) {
      if (!hasSupportedDropPayload(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        showDropOverlay(false);
      }
    }

    panel.addEventListener('dragover', event => {
      if (!hasSupportedDropPayload(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    panel.addEventListener('dragenter', handleDragEnter);
    panel.addEventListener('dragleave', handleDragLeave);
    panel.addEventListener('drop', event => {
      if (!hasSupportedDropPayload(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      dragDepth = 0;
      showDropOverlay(false);
      postDrop(event);
    });
    preview.addEventListener('dragover', event => {
      if (!hasSupportedDropPayload(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    preview.addEventListener('dragenter', handleDragEnter);
    preview.addEventListener('dragleave', handleDragLeave);
    preview.addEventListener('drop', event => {
      if (!hasSupportedDropPayload(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      dragDepth = 0;
      showDropOverlay(false);
      postDrop(event);
    });

    applyText.addEventListener('click', () => {
      if (!currentSelection) {
        applyHint.textContent = 'Select an element first.';
        return;
      }
      if (!currentCapabilities.canEditText) {
        applyHint.textContent = 'Selected element does not support Text editing.';
        return;
      }

      vscode.postMessage({
        type: 'applyProperty',
        elementName: currentSelection.elementName || '',
        typeName: currentSelection.typeName || '',
        property: 'Text',
        value: textValue.value || '',
        autoPush: !!autoPush.checked,
      });
    });

    applyBackground.addEventListener('click', () => {
      if (!currentSelection) {
        applyHint.textContent = 'Select an element first.';
        return;
      }
      if (!currentCapabilities.canEditBackground) {
        applyHint.textContent = 'Selected element does not support Background editing.';
        return;
      }

      vscode.postMessage({
        type: 'applyProperty',
        elementName: currentSelection.elementName || '',
        typeName: currentSelection.typeName || '',
        property: 'Background',
        value: backgroundValue.value || '',
        autoPush: !!autoPush.checked,
      });
    });

    applyForeground.addEventListener('click', () => {
      if (!currentSelection) {
        applyHint.textContent = 'Select an element first.';
        return;
      }
      if (!currentCapabilities.canEditForeground) {
        applyHint.textContent = 'Selected element does not support Foreground editing.';
        return;
      }

      vscode.postMessage({
        type: 'applyProperty',
        elementName: currentSelection.elementName || '',
        typeName: currentSelection.typeName || '',
        property: 'Foreground',
        value: foregroundValue.value || '',
        autoPush: !!autoPush.checked,
      });
    });

    window.addEventListener('message', event => {
      const msg = event.data || {};
      if (msg.type === 'loading') {
        state.style.display = 'block';
        state.textContent = 'Refreshing preview…';
        hitOverlay.style.display = 'none';
        showDropOverlay(false);
        return;
      }

      if (msg.type === 'error') {
        preview.style.display = 'none';
        state.style.display = 'block';
        state.textContent = msg.message || 'Could not capture preview.';
        selection.textContent = 'Selection: none';
        properties.textContent = 'Properties: none';
        applyHint.textContent = '';
        hitOverlay.style.display = 'none';
        showDropOverlay(false);
        return;
      }

      if (msg.type === 'snapshot') {
        preview.src = msg.imageDataUrl;
        rootWidth = Number(msg.width || 0);
        rootHeight = Number(msg.height || 0);
        preview.style.display = 'block';
        state.style.display = 'none';
        hitOverlay.style.display = 'none';
        showDropOverlay(false);
        meta.textContent =
          'Source: ' + (msg.source || 'runtime') + '\\n' +
          'Size: ' + msg.width + 'x' + msg.height + '\\n' +
          'Project: ' + (msg.projectPath || '') + '\\n' +
          'XAML: ' + (msg.xamlPath || '') + '\\n' +
          'Updated: ' + (msg.at || '');
        return;
      }

      if (msg.type === 'hitTestError') {
        selection.textContent = 'Selection: ' + (msg.message || 'none');
        properties.textContent = 'Properties: none';
        currentSelection = null;
        currentCapabilities = {
          canEditText: false,
          canEditBackground: false,
          canEditForeground: false,
        };
        applyText.disabled = true;
        applyBackground.disabled = true;
        applyForeground.disabled = true;
        return;
      }

      if (msg.type === 'applyResult') {
        applyHint.textContent = msg.message || (msg.ok ? 'Property applied.' : 'Property update failed.');
        return;
      }

      if (msg.type === 'insertResult') {
        applyHint.textContent = msg.message || (msg.ok ? 'Element inserted.' : 'Element insertion failed.');
        return;
      }

      if (msg.type === 'hitTestResult' && msg.hit) {
        const hit = msg.hit;
        currentSelection = hit;
        const typeName = hit.typeName || '(unknown)';
        const elementName = hit.elementName || '(unnamed)';
        selection.textContent =
          'Selection: ' + typeName + '\\n' +
          'Name: ' + elementName;
        if (msg.properties) {
          const p = msg.properties;
          textValue.value = p.text || '';
          backgroundValue.value = p.background || '';
          foregroundValue.value = p.foreground || '';
          currentCapabilities = {
            canEditText: !!p.canEditText,
            canEditBackground: !!p.canEditBackground,
            canEditForeground: !!p.canEditForeground,
          };
          applyText.disabled = !currentCapabilities.canEditText;
          applyBackground.disabled = !currentCapabilities.canEditBackground;
          applyForeground.disabled = !currentCapabilities.canEditForeground;
          properties.textContent =
            'Properties:\\n' +
            'Text: ' + (p.text || '(n/a)') + '\\n' +
            'Background: ' + (p.background || '(n/a)') + '\\n' +
            'Foreground: ' + (p.foreground || '(n/a)') + '\\n' +
            'Width/Height: ' + (p.width || '(auto)') + ' / ' + (p.height || '(auto)') + '\\n' +
            'Actual Size: ' + (p.actualWidth || '0') + ' x ' + (p.actualHeight || '0') + '\\n' +
            'Margin: ' + (p.margin || '(n/a)') + '\\n' +
            'Alignment: ' + (p.horizontalAlignment || '(n/a)') + ' / ' + (p.verticalAlignment || '(n/a)') + '\\n' +
            'IsEnabled: ' + (p.isEnabled || '(n/a)') + '\\n' +
            'Visibility: ' + (p.visibility || '(n/a)') + '\\n' +
            'Editable: Text=' + (currentCapabilities.canEditText ? 'Yes' : 'No') +
            ', Background=' + (currentCapabilities.canEditBackground ? 'Yes' : 'No') +
            ', Foreground=' + (currentCapabilities.canEditForeground ? 'Yes' : 'No');
        } else {
          properties.textContent = 'Properties: ' + (msg.propertiesError || 'unavailable');
          currentCapabilities = {
            canEditText: false,
            canEditBackground: false,
            canEditForeground: false,
          };
          applyText.disabled = true;
          applyBackground.disabled = true;
          applyForeground.disabled = true;
        }

        const rect = preview.getBoundingClientRect();
        if (rect.width && rect.height && rootWidth > 0 && rootHeight > 0) {
          const scaleX = rect.width / rootWidth;
          const scaleY = rect.height / rootHeight;
          const left = hit.boundsX * scaleX;
          const top = hit.boundsY * scaleY;
          const width = Math.max(1, hit.boundsWidth * scaleX);
          const height = Math.max(1, hit.boundsHeight * scaleY);

          hitOverlay.style.left = left + 'px';
          hitOverlay.style.top = top + 'px';
          hitOverlay.style.width = width + 'px';
          hitOverlay.style.height = height + 'px';
          hitOverlay.style.display = 'block';
        } else {
          hitOverlay.style.display = 'none';
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

function isLivePreviewToolboxItem(value: unknown): value is LivePreviewToolboxItem {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Partial<LivePreviewToolboxItem>;
  return item.kind === 'wpfToolboxItem'
    && typeof item.displayName === 'string'
    && typeof item.typeName === 'string'
    && typeof item.defaultSnippet === 'string'
    && typeof item.requiresPrefix === 'boolean';
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

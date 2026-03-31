import * as vscode from 'vscode';

const TOOLBOX_MIME = 'application/vnd.vscode-wpf.toolbox-item+json';

interface ToolboxItem {
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

interface ToolboxGroup {
  readonly title: string;
  readonly items: readonly ToolboxItem[];
}

const TOOLBOX_GROUPS: readonly ToolboxGroup[] = [
  {
    title: 'Core',
    items: [
      builtIn('Border', '<Border>\n\t$1\n</Border>'),
      builtIn('Canvas', '<Canvas>\n\t$1\n</Canvas>'),
      builtIn('ContentControl', '<ContentControl>\n\t$1\n</ContentControl>'),
      builtIn('Viewbox', '<Viewbox>\n\t$1\n</Viewbox>'),
    ],
  },
  {
    title: 'Layout',
    items: [
      builtIn('Grid', '<Grid>\n\t$1\n</Grid>'),
      builtIn('StackPanel', '<StackPanel>\n\t$1\n</StackPanel>'),
      builtIn('DockPanel', '<DockPanel>\n\t$1\n</DockPanel>'),
      builtIn('WrapPanel', '<WrapPanel>\n\t$1\n</WrapPanel>'),
      builtIn('UniformGrid', '<UniformGrid>\n\t$1\n</UniformGrid>'),
    ],
  },
  {
    title: 'Content',
    items: [
      builtIn('Button', '<Button Content="$1" />'),
      builtIn('TextBlock', '<TextBlock Text="$1" />'),
      builtIn('TextBox', '<TextBox Text="$1" />'),
      builtIn('Label', '<Label Content="$1" />'),
      builtIn('CheckBox', '<CheckBox Content="$1" />'),
      builtIn('RadioButton', '<RadioButton Content="$1" />'),
    ],
  },
  {
    title: 'Items',
    items: [
      builtIn('ListBox', '<ListBox>\n\t$1\n</ListBox>'),
      builtIn('ComboBox', '<ComboBox>\n\t$1\n</ComboBox>'),
      builtIn('TreeView', '<TreeView>\n\t$1\n</TreeView>'),
      builtIn('TabControl', '<TabControl>\n\t$1\n</TabControl>'),
      builtIn('DataGrid', '<DataGrid AutoGenerateColumns="False" />'),
    ],
  },
  {
    title: 'Shapes',
    items: [
      builtIn('Rectangle', '<Rectangle Width="100" Height="60" Fill="LightGray" />'),
      builtIn('Ellipse', '<Ellipse Width="60" Height="60" Fill="LightGray" />'),
      builtIn('Line', '<Line X1="0" Y1="0" X2="120" Y2="0" Stroke="Black" StrokeThickness="1" />'),
      builtIn('Path', '<Path Data="$1" Fill="LightGray" />'),
    ],
  },
  {
    title: 'Media',
    items: [
      builtIn('Image', '<Image Source="$1" Stretch="Uniform" />'),
      builtIn('MediaElement', '<MediaElement Source="$1" LoadedBehavior="Play" />'),
      builtIn('ProgressBar', '<ProgressBar Minimum="0" Maximum="100" Value="$1" />'),
      builtIn('Slider', '<Slider Minimum="0" Maximum="100" Value="$1" />'),
    ],
  },
  {
    title: 'Custom',
    items: [
      {
        kind: 'wpfToolboxItem',
        displayName: 'UserControl (local)',
        typeName: 'MyApp.Controls.MyControl',
        clrNamespace: 'MyApp.Controls',
        assemblyName: 'MyApp',
        prefixHint: 'local',
        requiresPrefix: true,
        defaultSnippet: '<local:MyControl />',
      },
    ],
  },
];

function builtIn(displayName: string, defaultSnippet: string): ToolboxItem {
  return {
    kind: 'wpfToolboxItem',
    displayName,
    typeName: `System.Windows.Controls.${displayName}`,
    xmlNamespace: 'http://schemas.microsoft.com/winfx/2006/xaml/presentation',
    requiresPrefix: false,
    defaultSnippet,
  };
}

export function registerToolbox(context: vscode.ExtensionContext): void {
  const provider = new WpfToolboxViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('wpf.toolbox', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentDropEditProvider(
      { scheme: 'file', language: 'xaml' },
      new WpfToolboxDropProvider(),
      {
        dropMimeTypes: [TOOLBOX_MIME, 'text/plain'],
      }
    )
  );
}

class WpfToolboxViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) { }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview);
  }
}

class WpfToolboxDropProvider implements vscode.DocumentDropEditProvider {
  async provideDocumentDropEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentDropEdit | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }

    const item = await readToolboxItem(dataTransfer);
    if (!item) {
      return undefined;
    }

    if (isInsideTagDeclaration(document, position)) {
      return undefined;
    }

    const resolvedPrefix = resolvePrefix(document, item);
    let snippetText = item.defaultSnippet;
    if (item.requiresPrefix) {
      const targetPrefix = resolvedPrefix?.prefix ?? item.prefixHint ?? 'local';
      snippetText = replaceSnippetPrefix(snippetText, item.prefixHint ?? 'local', targetPrefix);
    }

    const indent = getIndentForLine(document, position.line);
    const formattedSnippet = withIndent(snippetText, indent);
    const edit = new vscode.DocumentDropEdit(
      new vscode.SnippetString(formattedSnippet),
      `Insert ${item.displayName}`
    );

    if (resolvedPrefix?.needsDeclaration && resolvedPrefix.namespaceValue) {
      const additional = buildNamespaceInsertEdit(document, resolvedPrefix.prefix, resolvedPrefix.namespaceValue);
      if (additional) {
        edit.additionalEdit = additional;
      }
    }

    return edit;
  }
}

async function readToolboxItem(dataTransfer: vscode.DataTransfer): Promise<ToolboxItem | undefined> {
  const typed = dataTransfer.get(TOOLBOX_MIME);
  if (typed) {
    const raw = await typed.asString();
    const parsed = safeParse(raw);
    if (isToolboxItem(parsed)) {
      return parsed;
    }
  }

  const plain = dataTransfer.get('text/plain');
  if (plain) {
    const text = (await plain.asString()).trim();
    if (text.startsWith('<') && text.endsWith('>')) {
      return {
        kind: 'wpfToolboxItem',
        displayName: 'Snippet',
        typeName: 'Snippet',
        requiresPrefix: false,
        defaultSnippet: text,
      };
    }
  }

  return undefined;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isToolboxItem(value: unknown): value is ToolboxItem {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Partial<ToolboxItem>;
  return item.kind === 'wpfToolboxItem'
    && typeof item.displayName === 'string'
    && typeof item.typeName === 'string'
    && typeof item.defaultSnippet === 'string'
    && typeof item.requiresPrefix === 'boolean';
}

function getIndentForLine(document: vscode.TextDocument, line: number): string {
  const text = document.lineAt(line).text;
  const match = text.match(/^\s*/);
  return match ? match[0] : '';
}

function withIndent(snippet: string, indent: string): string {
  return snippet.replace(/\n/g, `\n${indent}`);
}

function isInsideTagDeclaration(document: vscode.TextDocument, position: vscode.Position): boolean {
  const offset = document.offsetAt(position);
  const before = document.getText().slice(0, offset);
  const lastOpen = before.lastIndexOf('<');
  const lastClose = before.lastIndexOf('>');
  if (lastOpen <= lastClose) {
    return false;
  }

  const segment = before.slice(lastOpen);
  if (segment.startsWith('<!--') || segment.startsWith('<![') || segment.startsWith('<?')) {
    return false;
  }

  return true;
}

interface PrefixResolution {
  readonly prefix: string;
  readonly needsDeclaration: boolean;
  readonly namespaceValue?: string;
}

function resolvePrefix(document: vscode.TextDocument, item: ToolboxItem): PrefixResolution | undefined {
  if (!item.requiresPrefix || !item.clrNamespace) {
    return undefined;
  }

  const root = findRootStartTag(document.getText());
  if (!root) {
    return {
      prefix: item.prefixHint ?? 'local',
      needsDeclaration: false,
    };
  }

  const declarations = parseXmlnsDeclarations(root.text);
  const clrValue = buildClrNamespaceValue(item.clrNamespace, item.assemblyName);
  for (const decl of declarations) {
    if (normalizeNamespaceValue(decl.value) === normalizeNamespaceValue(clrValue)) {
      return {
        prefix: decl.prefix ?? item.prefixHint ?? 'local',
        needsDeclaration: false,
      };
    }
  }

  const preferred = item.prefixHint ?? 'local';
  const used = new Set(declarations.map(d => d.prefix).filter((v): v is string => Boolean(v)));
  let candidate = preferred;
  let index = 1;
  while (used.has(candidate)) {
    candidate = `${preferred}${index}`;
    index++;
  }

  return {
    prefix: candidate,
    needsDeclaration: true,
    namespaceValue: clrValue,
  };
}

function buildClrNamespaceValue(clrNamespace: string, assemblyName?: string): string {
  if (assemblyName && assemblyName.trim().length > 0) {
    return `clr-namespace:${clrNamespace};assembly=${assemblyName}`;
  }

  return `clr-namespace:${clrNamespace}`;
}

function replaceSnippetPrefix(snippet: string, fromPrefix: string, toPrefix: string): string {
  if (fromPrefix === toPrefix) {
    return snippet;
  }

  const open = new RegExp(`<${escapeRegExp(fromPrefix)}:`, 'g');
  const close = new RegExp(`</${escapeRegExp(fromPrefix)}:`, 'g');
  return snippet.replace(open, `<${toPrefix}:`).replace(close, `</${toPrefix}:`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface XmlnsDeclaration {
  readonly prefix?: string;
  readonly value: string;
}

function parseXmlnsDeclarations(startTagText: string): XmlnsDeclaration[] {
  const declarations: XmlnsDeclaration[] = [];
  const regex = /\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(startTagText)) !== null) {
    const prefix = match[1];
    const value = (match[3] ?? match[4] ?? '').trim();
    declarations.push({ prefix, value });
  }

  return declarations;
}

function normalizeNamespaceValue(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

interface RootTagRange {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

function findRootStartTag(text: string): RootTagRange | undefined {
  let start = 0;
  while (start < text.length) {
    const idx = text.indexOf('<', start);
    if (idx < 0 || idx + 1 >= text.length) {
      return undefined;
    }

    const next = text[idx + 1];
    if (next === '?' || next === '!' || next === '/') {
      start = idx + 1;
      continue;
    }

    const end = findTagClose(text, idx);
    if (end < 0) {
      return undefined;
    }

    return {
      startOffset: idx,
      endOffset: end,
      text: text.slice(idx, end + 1),
    };
  }

  return undefined;
}

function findTagClose(text: string, startOffset: number): number {
  let quote: '"' | '\'' | undefined;
  for (let i = startOffset + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }

    if (ch === '>') {
      return i;
    }
  }

  return -1;
}

function buildNamespaceInsertEdit(document: vscode.TextDocument, prefix: string, namespaceValue: string): vscode.WorkspaceEdit | undefined {
  const root = findRootStartTag(document.getText());
  if (!root) {
    return undefined;
  }

  const insertPos = document.positionAt(root.endOffset);
  const rootLine = document.positionAt(root.startOffset).line;
  const rootIndent = getIndentForLine(document, rootLine);
  const lineBreak = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const text = `${lineBreak}${rootIndent}    xmlns:${prefix}="${namespaceValue}"`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, insertPos, text);
  return edit;
}

function getWebviewHtml(webview: vscode.Webview): string {
  const escapedGroups = JSON.stringify(TOOLBOX_GROUPS);
  const nonce = createNonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 8px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .group {
      margin-bottom: 10px;
    }
    .group-title {
      margin: 8px 0 4px 0;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      letter-spacing: 0.08em;
    }
    .item {
      display: block;
      width: 100%;
      box-sizing: border-box;
      border: 1px solid transparent;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      margin: 3px 0;
      padding: 6px 8px;
      font-size: 12px;
      text-align: left;
      cursor: grab;
      user-select: none;
    }
    .item:hover {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
    }
    .hint {
      margin-top: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <div class="hint">Drag a control into an open XAML editor tab or the Live Preview pane.</div>
  <script nonce="${nonce}">
    const TOOLBOX_MIME = ${JSON.stringify(TOOLBOX_MIME)};
    const groups = ${escapedGroups};
    const app = document.getElementById('app');

    for (const group of groups) {
      const wrapper = document.createElement('section');
      wrapper.className = 'group';

      const title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = group.title;
      wrapper.appendChild(title);

      for (const item of group.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'item';
        button.draggable = true;
        button.textContent = item.displayName;
        button.title = item.defaultSnippet;

        button.addEventListener('dragstart', event => {
          if (!event.dataTransfer) {
            return;
          }

          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData(TOOLBOX_MIME, JSON.stringify(item));
          event.dataTransfer.setData('text/plain', item.defaultSnippet);
        });

        wrapper.appendChild(button);
      }

      app.appendChild(wrapper);
    }
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

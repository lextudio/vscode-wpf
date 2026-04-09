import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { ensureDotnetRuntime, getPreferredDotnetPath } from './dotnetBootstrap';
import {
  DesignerProjectContext,
  HotReloadMapDocumentResult,
  requestDesignerProjectContext,
  requestHotReloadMapDocument,
} from './languageServerProtocol';

let client: LanguageClient | undefined;
let log: vscode.OutputChannel | undefined;

function getLog(): vscode.OutputChannel {
  if (!log) {
    log = vscode.window.createOutputChannel('WPF Extension');
  }
  return log;
}

/**
 * Start the WPF XAML language server if the server binary exists.
 * Safe to call multiple times — a running client is not restarted.
 */
export async function startLanguageServer(context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }

  const dotnetPath = await ensureDotnetRuntime();

  const serverExe = resolveServerExecutable(context);
  if (!serverExe) {
    getLog().appendLine('[Language Server] Binary not found in tools/XamlLanguageServer/ — run "WPF: Build Language Server" to build it.');
    return;
  }

  getLog().appendLine(`[Language Server] Starting: ${serverExe}`);
  if (dotnetPath) {
    getLog().appendLine(`[Language Server] dotnet host: ${dotnetPath}`);
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    getLog().appendLine(`[Language Server] Workspace: ${workspaceRoot}`);
  }

  const serverArgs = workspaceRoot ? ['--workspace', workspaceRoot] : [];
  const serverOptions: ServerOptions = /\.dll$/i.test(serverExe)
    ? {
        command: getPreferredDotnetPath(),
        args: [serverExe, ...serverArgs],
        transport: TransportKind.stdio,
      }
    : {
        command: serverExe,
        args: serverArgs,
        transport: TransportKind.stdio,
      };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'xaml' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.xaml'),
    },
    outputChannelName: 'WPF XAML Language Server',
  };

  client = new LanguageClient(
    'wpf-xaml-ls',
    'WPF XAML Language Server',
    serverOptions,
    clientOptions
  );

  client.onDidChangeState(e => {
    getLog().appendLine(`[Language Server] State: ${stateLabel(e.oldState)} → ${stateLabel(e.newState)}`);
  });

  context.subscriptions.push(client);

  try {
    await client.start();
    getLog().appendLine('[Language Server] Ready.');
    // Handle server notification that a WPF project may be missing
    // <EnableWindowsTargeting>true</EnableWindowsTargeting> (non-Windows hosts).
    client.onNotification('axsg/enableWindowsTargetingMissing', (params: any) => {
      try {
        const projectPath = params?.projectPath;
        if (projectPath) {
          // Delegate the user prompt & fix to the extension command handler.
          void vscode.commands.executeCommand('wpf.addEnableWindowsTargeting', projectPath);
        }
      } catch (err) {
        getLog().appendLine(`[Language Server] enableWindowsTargetingMissing handler error: ${err}`);
      }
    });

      // Query server for any missing EnableWindowsTargeting detections
      // that may have occurred before the client registered handlers.
      try {
        const missing: string[] | undefined = await client.sendRequest('axsg/getMissingEnableWindowsTargeting');
        if (Array.isArray(missing)) {
          for (const projectPath of missing) {
            if (projectPath) {
              void vscode.commands.executeCommand('wpf.addEnableWindowsTargeting', projectPath);
            }
          }
        }
      } catch (err) {
        getLog().appendLine(`[Language Server] getMissingEnableWindowsTargeting request failed: ${err}`);
      }
  } catch (err) {
    getLog().appendLine(`[Language Server] Failed to start: ${err}`);
    vscode.window.showErrorMessage(`WPF XAML Language Server failed to start. See "WPF Extension" output channel.`);
    client = undefined;
  }
}

/** Stop the language server (called on extension deactivate). */
export async function stopLanguageServer(): Promise<void> {
  if (client) {
    getLog().appendLine('[Language Server] Stopping.');
    await client.stop();
    client = undefined;
  }
  log?.dispose();
  log = undefined;
}

export function getLanguageServerClient(): LanguageClient | undefined {
  return client;
}

export async function getDesignerProjectContext(documentUri: vscode.Uri): Promise<DesignerProjectContext | null> {
  return requestDesignerProjectContext(client, documentUri);
}

export const getPreviewProjectContext = getDesignerProjectContext;

export async function getHotReloadMapDocument(
  documentUri: vscode.Uri,
  elementName: string,
  typeName: string
): Promise<HotReloadMapDocumentResult | null> {
  return requestHotReloadMapDocument(client, documentUri, elementName, typeName);
}

/**
 * Resolve the path to `wpf-xaml-ls.exe` in the extension's tools directory.
 * Returns null if the binary has not been built yet.
 */
function resolveServerExecutable(context: vscode.ExtensionContext): string | null {
  const toolsDir = path.join(context.extensionPath, 'tools', 'XamlLanguageServer');
  getLog().appendLine(`[Language Server] Looking for binary in: ${toolsDir}`);

  for (const name of ['wpf-xaml-ls.exe', 'wpf-xaml-ls.dll']) {
    const candidate = path.join(toolsDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function stateLabel(state: number): string {
  // vscode-languageclient State enum: 1=Starting, 2=Running, 3=Stopped
  switch (state) {
    case 1: return 'Starting';
    case 2: return 'Running';
    case 3: return 'Stopped';
    default: return `Unknown(${state})`;
  }
}

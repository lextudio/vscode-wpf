import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/**
 * Start the WPF XAML language server if the server binary exists.
 * Safe to call multiple times — a running client is not restarted.
 */
export async function startLanguageServer(context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }

  const serverExe = resolveServerExecutable(context);
  if (!serverExe) {
    // Binary not yet built — silently skip; user can run "WPF: Build Designer Tools"
    // which also builds the language server.
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const serverOptions: ServerOptions = {
    command: serverExe,
    args: workspaceRoot ? ['--workspace', workspaceRoot] : [],
    transport: TransportKind.stdio,
  };

  const clientOptions: LanguageClientOptions = {
    // Only activate for XAML files that are WPF (validated before reaching the LSP).
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

  context.subscriptions.push(client);
  await client.start();
}

/** Stop the language server (called on extension deactivate). */
export async function stopLanguageServer(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

/**
 * Resolve the path to `wpf-xaml-ls.exe` in the extension's tools directory.
 * Returns null if the binary has not been built yet.
 */
function resolveServerExecutable(context: vscode.ExtensionContext): string | null {
  const toolsDir = path.join(context.extensionPath, 'tools', 'XamlLanguageServer');

  for (const name of ['wpf-xaml-ls.exe', 'wpf-xaml-ls.dll']) {
    const candidate = path.join(toolsDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

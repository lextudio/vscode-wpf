import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
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
  const dotnetHostPath = resolveSdkDotnetHostPath(getPreferredDotnetPath()) ?? getPreferredDotnetPath();
  if (dotnetHostPath !== getPreferredDotnetPath()) {
    getLog().appendLine(`[Language Server] SDK dotnet host: ${dotnetHostPath}`);
  }
  const serverEnv = createDotnetServerEnvironment(dotnetHostPath);
  const serverOptions: ServerOptions = /\.dll$/i.test(serverExe)
    ? {
        command: dotnetHostPath,
        args: [serverExe, ...serverArgs],
        transport: TransportKind.stdio,
        options: {
          env: serverEnv,
        },
      }
    : {
        command: serverExe,
        args: serverArgs,
        transport: TransportKind.stdio,
        options: {
          env: serverEnv,
        },
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

function createDotnetServerEnvironment(dotnetPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const resolvedDotnetPath = resolveDotnetHostPath(dotnetPath);
  if (resolvedDotnetPath) {
    env.DOTNET_HOST_PATH = resolvedDotnetPath;

    // Prefer DOTNET_ROOT reported by `dotnet --info` over dirname(resolvedPath).
    // On Homebrew, the dotnet symlink points to a shim shell script whose dirname
    // is "bin/", but the real SDK/runtime lives in "libexec/". The shim sets
    // DOTNET_ROOT correctly before exec-ing the real binary, but if we pass a
    // wrong DOTNET_ROOT env var it overrides the shim, causing hostfxr_resolve_sdk2
    // failures in MSBuildWorkspace.
    const dotnetRoot = getDotnetRootFromInfo(dotnetPath) ?? path.dirname(resolvedDotnetPath);
    env.DOTNET_ROOT = dotnetRoot;
    env.PATH = prependPath(dotnetRoot, env.PATH);
  }

  return env;
}

function getDotnetRootFromInfo(dotnetPath: string): string | null {
  try {
    const result = cp.spawnSync(dotnetPath, ['--info'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    const match = result.stdout.match(/DOTNET_ROOT\s+\[([^\]]+)\]/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function resolveDotnetHostPath(dotnetPath: string): string | null {
  if (!dotnetPath) {
    return null;
  }

  if (dotnetPath === 'dotnet') {
    return resolveDotnetFromPath();
  }

  try {
    return fs.realpathSync(dotnetPath);
  } catch {
    return path.resolve(dotnetPath);
  }
}

function resolveSdkDotnetHostPath(preferredDotnetPath: string): string | null {
  const candidates = new Set<string>();
  const preferred = resolveDotnetHostPath(preferredDotnetPath);
  if (preferred) {
    candidates.add(preferred);
  }

  for (const candidate of getStandardDotnetHostCandidates()) {
    candidates.add(candidate);
  }

  for (const candidate of candidates) {
    if (hasDotnetSdk(candidate)) {
      return candidate;
    }
  }

  return preferred;
}

function resolveDotnetFromPath(): string | null {
  const command = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? ['dotnet'] : ['-v', 'dotnet'];
  try {
    const result = cp.spawnSync(command, args, {
      encoding: 'utf8',
      shell: process.platform !== 'win32',
      windowsHide: true,
    });
    const first = result.stdout
      ?.split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.length > 0);
    return first ? fs.realpathSync(first) : null;
  } catch {
    return null;
  }
}

function getStandardDotnetHostCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles;
    return programFiles ? [path.join(programFiles, 'dotnet', 'dotnet.exe')] : [];
  }

  return [
    '/opt/homebrew/bin/dotnet',
    '/opt/homebrew/share/dotnet/dotnet',
    '/usr/local/bin/dotnet',
    '/usr/local/share/dotnet/dotnet',
    '/usr/share/dotnet/dotnet',
  ];
}

function hasDotnetSdk(dotnetPath: string): boolean {
  if (!fs.existsSync(dotnetPath)) {
    return false;
  }

  try {
    const result = cp.spawnSync(dotnetPath, ['--list-sdks'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function prependPath(directory: string, currentPath: string | undefined): string {
  if (!currentPath || currentPath.length === 0) {
    return directory;
  }

  const separator = process.platform === 'win32' ? ';' : ':';
  const entries = currentPath.split(separator);
  if (entries.some(entry => path.resolve(entry) === path.resolve(directory))) {
    return currentPath;
  }

  return `${directory}${separator}${currentPath}`;
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

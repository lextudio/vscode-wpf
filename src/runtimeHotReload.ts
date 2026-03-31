import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { areProjectOutputsUpToDate, getLaunchTarget } from './projectDiscovery';
import { buildProject } from './designerLauncher';

interface RuntimeSessionInfo {
  debugSession: vscode.DebugSession;
  projectPath: string;
  xamlPath?: string;
  warnedUnsupportedApply: boolean;
  pipeName?: string;
}

let outputChannel: vscode.OutputChannel | undefined;
let extensionPath: string | undefined;

const runtimeSessionsByProject = new Map<string, RuntimeSessionInfo>();
const runtimeSessionsByDebugId = new Map<string, RuntimeSessionInfo>();
const pendingPipeNameByProject = new Map<string, string>();

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('WPF Hot Reload');
  }

  return outputChannel;
}

export function showRuntimeHotReloadOutput(): void {
  getOutputChannel().show(true);
}

export function registerRuntimeHotReload(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('wpf-sharpdbg', new SharpDbgConfigurationProvider())
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      'wpf-sharpdbg',
      new SharpDbgDebugAdapterFactory(context)
    )
  );

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      if (session.type !== 'wpf-sharpdbg') {
        return;
      }

      const projectPath = getProjectPathFromSession(session);
      if (!projectPath) {
        return;
      }

      const info: RuntimeSessionInfo = {
        debugSession: session,
        projectPath,
        xamlPath: getXamlPathFromSession(session),
        warnedUnsupportedApply: false,
        pipeName: pendingPipeNameByProject.get(projectPath),
      };
      pendingPipeNameByProject.delete(projectPath);

      runtimeSessionsByProject.set(projectPath, info);
      runtimeSessionsByDebugId.set(session.id, info);
      getOutputChannel().appendLine(`[Runtime] Started debug session for ${projectPath}`);
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      if (session.type !== 'wpf-sharpdbg') {
        return;
      }

      const info = runtimeSessionsByDebugId.get(session.id);
      if (!info) {
        return;
      }

      runtimeSessionsByDebugId.delete(session.id);
      runtimeSessionsByProject.delete(info.projectPath);
      getOutputChannel().appendLine(`[Runtime] Terminated debug session for ${info.projectPath}`);
    })
  );

  context.subscriptions.push({
    dispose: () => {
      runtimeSessionsByProject.clear();
      runtimeSessionsByDebugId.clear();
      outputChannel?.dispose();
      outputChannel = undefined;
    },
  });
}

export function hasRunningRuntimeSession(projectPath: string): boolean {
  return runtimeSessionsByProject.has(projectPath);
}

export function getRuntimeSessionInfo(projectPath: string): RuntimeSessionInfo | undefined {
  return runtimeSessionsByProject.get(projectPath);
}

export async function startRuntimeHotReloadSession(
  context: vscode.ExtensionContext,
  projectPath: string,
  xamlPath?: string
): Promise<boolean> {
  if (hasRunningRuntimeSession(projectPath)) {
    getOutputChannel().appendLine(`[Runtime] Reusing existing debug session for ${projectPath}`);
    return true;
  }

  const cfg = vscode.workspace.getConfiguration('wpf');
  const dotnetPath = cfg.get<string>('dotnetPath', 'dotnet');
  const autoBuild = cfg.get<boolean>('autoBuildOnPreview', true);

  if (autoBuild && !areProjectOutputsUpToDate(projectPath)) {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Building ${path.basename(projectPath)} for hot reload…`,
        cancellable: true,
      },
      (_progress, token) => buildProject(projectPath, token)
    );

    if (!result.success) {
      vscode.window.showErrorMessage(`Build failed for ${path.basename(projectPath)}.`);
      return false;
    }
  }

  // Build the hot reload helper before launching so we can inject it
  // via DOTNET_STARTUP_HOOKS. This makes the pipe listener available
  // immediately when the WPF app starts, bypassing debugger eval entirely.
  const helperAssemblyPath = await ensureRuntimeHelperBuilt();

  const launchTarget = getLaunchTarget(projectPath, dotnetPath);
  if (!launchTarget) {
    vscode.window.showErrorMessage(
      `Could not find a launchable output for ${path.basename(projectPath)}. Build the project first.`
    );
    return false;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath));
  const name = `WPF Hot Reload: ${path.basename(projectPath, '.csproj')}`;

  const pipeName = `wpf-hotreload-${crypto.randomUUID()}`;
  const env: Record<string, string> = {
    WPF_HOTRELOAD_PIPE: pipeName,
  };
  if (helperAssemblyPath) {
    env['DOTNET_STARTUP_HOOKS'] = helperAssemblyPath;
    getOutputChannel().appendLine(`[Runtime] Injecting helper via DOTNET_STARTUP_HOOKS: ${helperAssemblyPath}`);
  }
  getOutputChannel().appendLine(`[Runtime] Pipe name: ${pipeName}`);

  // Store the pipe name so it's available when the debug session starts
  pendingPipeNameByProject.set(projectPath, pipeName);

  getOutputChannel().appendLine(`[Runtime] Launching ${launchTarget.program} ${launchTarget.args.join(' ')}`.trim());

  return vscode.debug.startDebugging(workspaceFolder, {
    type: 'wpf-sharpdbg',
    name,
    request: 'launch',
    program: launchTarget.program,
    args: launchTarget.args,
    cwd: launchTarget.cwd,
    env,
    stopAtEntry: false,
    projectPath,
    xamlPath,
  });
}

export async function pushRuntimeXamlUpdate(
  projectPath: string,
  xamlPath: string,
  xamlText: string
): Promise<boolean> {
  getOutputChannel().appendLine(`[Runtime] Manual hot reload requested for ${xamlPath}`);
  const info = runtimeSessionsByProject.get(projectPath);
  if (!info) {
    getOutputChannel().appendLine(`[Runtime] No running debug session found for ${projectPath}`);
    return false;
  }

  info.xamlPath = xamlPath;

  // Primary path: named pipe (injected via DOTNET_STARTUP_HOOKS at launch).
  // The pipe listener starts automatically when the WPF app initializes,
  // so it should be available by the time the user clicks Hot Reload.
  // Retry a few times in case the pipe listener is still starting up.
  if (info.pipeName) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        getOutputChannel().appendLine(`[Runtime] Retrying pipe connection (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, 1000));
      }

      const pipeResult = await sendViaPipe(info.pipeName, xamlPath, xamlText);
      if (pipeResult) {
        if (pipeResult.success) {
          getOutputChannel().appendLine(`[Runtime] Applied XAML update via pipe for ${xamlPath}: ${pipeResult.message}`);
          return true;
        }

        getOutputChannel().appendLine(`[Runtime] Pipe apply failed for ${xamlPath}: ${pipeResult.message}`);
        vscode.window.showWarningMessage(`WPF hot reload failed: ${pipeResult.message}`);
        return false;
      }
    }

    getOutputChannel().appendLine(`[Runtime] Pipe not available after 3 attempts, falling back to DAP for ${xamlPath}`);
  }

  // Fallback: DAP-based debugger evaluation path.
  // Used when DOTNET_STARTUP_HOOKS injection didn't work or the pipe
  // listener hasn't started yet.
  const helperAssemblyPath = await ensureRuntimeHelperBuilt();
  if (!helperAssemblyPath) {
    getOutputChannel().appendLine('[Runtime] Runtime helper could not be built or located.');
    return false;
  }

  try {
    const result = await sendWpfHotReloadRequest(info.debugSession, helperAssemblyPath, xamlPath, xamlText);
    if (!result.success) {
      getOutputChannel().appendLine(`[Runtime] Hot reload rejected for ${xamlPath}: ${result.message}`);
      vscode.window.showWarningMessage(`WPF hot reload failed: ${result.message}`);
      return false;
    }

    getOutputChannel().appendLine(`[Runtime] Applied XAML update for ${xamlPath}: ${result.message}`);

    // Capture pipe name from response for subsequent requests
    if (result.pipeName && !info.pipeName) {
      info.pipeName = result.pipeName;
      getOutputChannel().appendLine(`[Runtime] Pipe channel available: ${result.pipeName}`);
    }

    return true;
  } catch (err) {
    getOutputChannel().appendLine(
      `[Runtime] Adapter does not yet handle WPF hot reload requests for ${xamlPath}: ${String(err)}`
    );

    if (!info.warnedUnsupportedApply) {
      info.warnedUnsupportedApply = true;
      void vscode.window.showInformationMessage(
        'The app is running under SharpDbg, but the debug adapter did not accept the WPF hot reload request.'
      );
    }

    return false;
  }
}

function sendViaPipe(
  pipeName: string,
  filePath: string,
  xamlText: string
): Promise<{ success: boolean; message: string } | null> {
  return new Promise(resolve => {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const client = net.createConnection(pipePath, () => {
      const request = JSON.stringify({ filePath, xamlText }) + '\n';
      client.write(request);
    });

    let data = '';
    client.on('data', chunk => {
      data += chunk.toString();
    });

    client.on('end', () => {
      try {
        const line = data.trim();
        if (!line) {
          resolve(null);
          return;
        }

        const response = JSON.parse(line) as { result?: string };
        const result = response.result ?? 'unknown';
        const success = !result.startsWith('error:');
        resolve({ success, message: result });
      } catch {
        resolve(null);
      }
    });

    client.on('error', (err) => {
      getOutputChannel().appendLine(`[Runtime] Pipe connection error: ${err.message}`);
      resolve(null);
    });

    client.setTimeout(10000, () => {
      client.destroy();
      resolve(null);
    });
  });
}

class SharpDbgConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type) {
      config.type = 'wpf-sharpdbg';
    }

    if (!config.name) {
      config.name = 'WPF Hot Reload';
    }

    if (!config.request) {
      config.request = 'launch';
    }

    if (!config.cwd && config.projectPath) {
      config.cwd = path.dirname(config.projectPath);
    }

    return config;
  }
}

class SharpDbgDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly context: vscode.ExtensionContext) { }

  createDebugAdapterDescriptor(
    _session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const executable = resolveSharpDbgExecutable(this.context);
    if (!executable) {
      throw new Error(
        'SharpDbg.Cli was not found. Build SharpDbg or set the wpf.sharpDbgExecutable setting.'
      );
    }

    const args = ['--interpreter=vscode'];
    if (/\.dll$/i.test(executable)) {
      const dotnetPath = vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet');
      getOutputChannel().appendLine(`[Runtime] Using SharpDbg adapter via dotnet host: ${executable}`);
      return new vscode.DebugAdapterExecutable(dotnetPath, [executable, ...args]);
    }

    getOutputChannel().appendLine(`[Runtime] Using SharpDbg adapter: ${executable}`);
    return new vscode.DebugAdapterExecutable(executable, args);
  }
}

function resolveSharpDbgExecutable(context: vscode.ExtensionContext): string | null {
  const override = vscode.workspace.getConfiguration('wpf').get<string>('sharpDbgExecutable', '').trim();
  if (override && fs.existsSync(override)) {
    return override;
  }

  const candidates = [
    path.join(context.extensionPath, 'tools', 'SharpDbg', 'SharpDbg.Cli.exe'),
    path.join(context.extensionPath, 'tools', 'SharpDbg', 'SharpDbg.Cli.dll'),
    path.join(context.extensionPath, 'external', 'SharpDbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'debug', 'SharpDbg.Cli.exe'),
    path.join(context.extensionPath, 'external', 'SharpDbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'debug', 'SharpDbg.Cli.dll'),
    path.join(context.extensionPath, 'external', 'SharpDbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'Debug', 'net10.0', 'SharpDbg.Cli.exe'),
    path.join(context.extensionPath, 'external', 'SharpDbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'Debug', 'net10.0', 'SharpDbg.Cli.dll'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function ensureRuntimeHelperBuilt(): Promise<string | null> {
  if (!extensionPath) {
    return null;
  }

  const outputDir = path.join(extensionPath, 'tools', 'WpfHotReload.Runtime');
  const helperDll = path.join(outputDir, 'WpfHotReload.Runtime.dll');
  const projectPath = path.join(extensionPath, 'src', 'WpfHotReload.Runtime', 'WpfHotReload.Runtime.csproj');
  if (!fs.existsSync(projectPath)) {
    vscode.window.showErrorMessage('WPF hot reload runtime helper project was not found.');
    return null;
  }

  if (isRuntimeHelperUpToDate(projectPath, helperDll)) {
    return helperDll;
  }

  const dotnetPath = vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet');
  getOutputChannel().appendLine(`[Runtime] Building WPF hot reload helper from ${projectPath}`);

  const buildSucceeded = await new Promise<boolean>(resolve => {
    const args = ['build', projectPath, '-c', 'Debug', '-nologo', '-p:OutDir=' + `${outputDir}${path.sep}`];
    const proc = cp.spawn(dotnetPath, args, { shell: true, cwd: extensionPath });

    proc.stdout?.on('data', chunk => getOutputChannel().append(chunk.toString()));
    proc.stderr?.on('data', chunk => getOutputChannel().append(chunk.toString()));
    proc.on('error', () => resolve(false));
    proc.on('close', code => resolve(code === 0));
  });

  if (!buildSucceeded || !fs.existsSync(helperDll)) {
    vscode.window.showErrorMessage('Failed to build the WPF hot reload runtime helper.');
    return null;
  }

  return helperDll;
}

interface HotReloadResult {
  success: boolean;
  message: string;
  pipeName?: string;
}

async function sendWpfHotReloadRequest(
  debugSession: vscode.DebugSession,
  helperAssemblyPath: string,
  filePath: string,
  xamlText: string
): Promise<HotReloadResult> {
  try {
    const response = await debugSession.customRequest('vsCustomMessage', {
      message: {
        sourceId: 'wpfHotReload',
        messageCode: 1001,
        parameter1: helperAssemblyPath,
        parameter2: filePath,
        xamlText,
      },
    });

    const parsedVsResponse = parseVsCustomMessageResponse(response);
    if (parsedVsResponse) {
      return parsedVsResponse;
    }
  } catch (err) {
    getOutputChannel().appendLine(`[Runtime] vsCustomMessage path failed, falling back: ${String(err)}`);
  }

  const fallbackResponse = await debugSession.customRequest('wpfHotReload/applyXamlText', {
    helperAssemblyPath,
    filePath,
    xamlText,
  });

  return parseLegacyHotReloadResponse(fallbackResponse);
}

function parseVsCustomMessageResponse(response: unknown): HotReloadResult | null {
  const container = asRecord(response);
  const responseMessage = asRecord(container?.responseMessage) ?? asRecord(asRecord(container?.body)?.responseMessage);
  if (!responseMessage) {
    return null;
  }

  const success = typeof responseMessage.parameter1 === 'boolean' ? responseMessage.parameter1 : false;
  const message =
    typeof responseMessage.parameter2 === 'string'
      ? responseMessage.parameter2
      : success
        ? 'ok'
        : 'unknown response';

  return { success, message };
}

function parseLegacyHotReloadResponse(response: unknown): HotReloadResult {
  const body = asRecord(response);
  const success = readBooleanField(body, 'success') ?? readBooleanField(asRecord(body?.body), 'success') ?? false;
  const message = readStringField(body ?? {}, 'message')
    ?? readStringField(asRecord(body?.body) ?? {}, 'message')
    ?? (success ? 'ok' : 'unknown response');
  const pipeName = readStringField(body ?? {}, 'pipeName')
    ?? readStringField(asRecord(body?.body) ?? {}, 'pipeName');

  return { success, message, pipeName };
}

function isRuntimeHelperUpToDate(projectPath: string, helperDllPath: string): boolean {
  if (!fs.existsSync(helperDllPath)) {
    return false;
  }

  const helperMtime = fs.statSync(helperDllPath).mtimeMs;
  const helperProjectDir = path.dirname(projectPath);
  const pending: string[] = [helperProjectDir];
  const watchedExtensions = new Set(['.cs', '.csproj', '.props', '.targets', '.resx']);

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'bin' && entry.name !== 'obj') {
          pending.push(fullPath);
        }
        continue;
      }

      if (!watchedExtensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      if (fs.statSync(fullPath).mtimeMs > helperMtime) {
        return false;
      }
    }
  }

  return true;
}

function getProjectPathFromSession(session: vscode.DebugSession): string | undefined {
  return readStringField(session.configuration, 'projectPath');
}

function getXamlPathFromSession(session: vscode.DebugSession): string | undefined {
  return readStringField(session.configuration, 'xamlPath');
}

function readStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBooleanField(source: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!source) {
    return undefined;
  }

  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

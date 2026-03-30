import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { areProjectOutputsUpToDate, getLaunchTarget } from './projectDiscovery';
import { buildProject } from './designerLauncher';

interface RuntimeSessionInfo {
  debugSession: vscode.DebugSession;
  projectPath: string;
  xamlPath?: string;
  warnedUnsupportedApply: boolean;
}

let outputChannel: vscode.OutputChannel | undefined;
let extensionPath: string | undefined;

const runtimeSessionsByProject = new Map<string, RuntimeSessionInfo>();
const runtimeSessionsByDebugId = new Map<string, RuntimeSessionInfo>();

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('WPF Hot Reload');
  }

  return outputChannel;
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
      };

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

  const launchTarget = getLaunchTarget(projectPath, dotnetPath);
  if (!launchTarget) {
    vscode.window.showErrorMessage(
      `Could not find a launchable output for ${path.basename(projectPath)}. Build the project first.`
    );
    return false;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath));
  const name = `WPF Hot Reload: ${path.basename(projectPath, '.csproj')}`;

  getOutputChannel().appendLine(`[Runtime] Launching ${launchTarget.program} ${launchTarget.args.join(' ')}`.trim());

  return vscode.debug.startDebugging(workspaceFolder, {
    type: 'wpf-sharpdbg',
    name,
    request: 'launch',
    program: launchTarget.program,
    args: launchTarget.args,
    cwd: launchTarget.cwd,
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
  const liveRuntimeOnEdit = vscode.workspace.getConfiguration('wpf').get<boolean>('liveRuntimeOnEdit', true);
  if (!liveRuntimeOnEdit) {
    return false;
  }

  const info = runtimeSessionsByProject.get(projectPath);
  if (!info) {
    return false;
  }

  const helperAssemblyPath = await ensureRuntimeHelperBuilt();
  if (!helperAssemblyPath) {
    return false;
  }

  info.xamlPath = xamlPath;

  try {
    await info.debugSession.customRequest('wpfHotReload/applyXamlText', {
      helperAssemblyPath,
      projectPath,
      filePath: xamlPath,
      xamlText,
    });
    getOutputChannel().appendLine(`[Runtime] Applied XAML update for ${xamlPath}`);
    return true;
  } catch (err) {
    getOutputChannel().appendLine(
      `[Runtime] Adapter does not yet handle wpfHotReload/applyXamlText for ${xamlPath}: ${String(err)}`
    );

    if (!info.warnedUnsupportedApply) {
      info.warnedUnsupportedApply = true;
      void vscode.window.showInformationMessage(
        'The app is running under SharpDbg, but the runtime-side XAML apply bridge is not implemented yet. ' +
        'The extension is ready to route live edits once the adapter/runtime helper is added.'
      );
    }

    return false;
  }
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
  if (fs.existsSync(helperDll)) {
    return helperDll;
  }

  const projectPath = path.join(extensionPath, 'src', 'WpfHotReload.Runtime', 'WpfHotReload.Runtime.csproj');
  if (!fs.existsSync(projectPath)) {
    vscode.window.showErrorMessage('WPF hot reload runtime helper project was not found.');
    return null;
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

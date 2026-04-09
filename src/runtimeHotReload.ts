import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { areProjectOutputsUpToDate, getLaunchTarget, parseProject } from './projectDiscovery';
import { buildProject } from './designerLauncher';
import { resolveSharpDbgAdapter, promptInstallSharpDbg } from './sharpdbgAdapter';

interface RuntimeSessionInfo {
  childProcess: cp.ChildProcess;
  projectPath: string;
  xamlPath?: string;
  warnedUnsupportedApply: boolean;
  pipeName: string;
  pipeReady: boolean;
  logFilePath?: string;
}

type XamlChangeKind = 'property' | 'subtree' | 'resource' | 'fullFile' | 'restart';

interface XamlPropertyChange {
  elementName: string;
  elementType: string;
  property: string;
  newValue: string;
  line: number;
  column: number;
}

interface XamlChangeClassification {
  changeKind: XamlChangeKind;
  propertyChanges: XamlPropertyChange[];
}

export interface RuntimePushResult {
  success: boolean;
  message: string;
  degraded: boolean;
}

let outputChannel: vscode.OutputChannel | undefined;
let extensionPath: string | undefined;

const runtimeSessionsByProject = new Map<string, RuntimeSessionInfo>();
const previousXamlByFile = new Map<string, string>();

function toProjectSessionKey(projectPath: string): string {
  const normalized = path.normalize(projectPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('WPF Hot Reload');
  }

  return outputChannel;
}

function getAutoBuildOnDesignerLaunch(configuration: vscode.WorkspaceConfiguration): boolean {
  const explicit = configuration.get<boolean | undefined>('autoBuildOnDesignerLaunch');
  if (typeof explicit === 'boolean') {
    return explicit;
  }

  return configuration.get<boolean>('autoBuildOnPreview', true);
}

export function showRuntimeHotReloadOutput(): void {
  getOutputChannel().show(true);
}

export function registerRuntimeHotReload(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;

  context.subscriptions.push({
    dispose: () => {
      for (const info of runtimeSessionsByProject.values()) {
        try {
          info.childProcess.kill();
        } catch {
          // ignore
        }
      }
      runtimeSessionsByProject.clear();
      outputChannel?.dispose();
      outputChannel = undefined;
    },
  });
}

export function hasRunningRuntimeSession(projectPath: string): boolean {
  return runtimeSessionsByProject.has(toProjectSessionKey(projectPath));
}

export function getRuntimeSessionInfo(projectPath: string): RuntimeSessionInfo | undefined {
  return runtimeSessionsByProject.get(toProjectSessionKey(projectPath));
}

interface HotReloadLaunchPrep {
  sessionKey: string;
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  pipeName: string;
  logFilePath?: string;
  helperAssemblyPath: string;
  isFramework: boolean;
  xamlPath?: string;
}

async function prepareHotReloadLaunch(
  context: vscode.ExtensionContext,
  projectPath: string,
  xamlPath?: string
): Promise<HotReloadLaunchPrep | null> {
  const sessionKey = toProjectSessionKey(projectPath);
  const channel = getOutputChannel();

  if (runtimeSessionsByProject.has(sessionKey)) {
    channel.appendLine(`[Runtime] Reusing existing session for ${projectPath}`);
    return null;
  }

  const { targetFramework } = parseProject(projectPath);
  const helperTargetTfm = resolveRuntimeHelperTargetFramework(targetFramework);
  const isFramework = helperTargetTfm === 'net462';

  const cfg = vscode.workspace.getConfiguration('wpf');
  const dotnetPath = cfg.get<string>('dotnetPath', 'dotnet');
  const autoBuild = getAutoBuildOnDesignerLaunch(cfg);
  const enableLogging = cfg.get<boolean>('enableRuntimeHotReloadLogging', false);

  if (autoBuild && !areProjectOutputsUpToDate(projectPath)) {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Building ${path.basename(projectPath)} for Hot Reload…`,
        cancellable: true,
      },
      (_progress, token) => buildProject(projectPath, token)
    );

    if (!result.success) {
      vscode.window.showErrorMessage(`Build failed for ${path.basename(projectPath)}.`);
      return null;
    }
  }

  const helperAssemblyPath = await ensureRuntimeHelperBuilt(projectPath, helperTargetTfm, channel);

  const launchTarget = getLaunchTarget(projectPath, dotnetPath);
  if (!launchTarget) {
    vscode.window.showErrorMessage(
      `Could not find a launchable output for ${path.basename(projectPath)}. Build the project first.`
    );
    return null;
  }

  const pipeName = `wpf-hotreload-${crypto.randomUUID()}`;
  const env: Record<string, string | undefined> = { ...process.env };
  let logFilePath: string | undefined;
  if (enableLogging) {
    logFilePath = path.join(
      extensionPath ?? process.cwd(),
      '.logs',
      'wpf-hotreload',
      `${pipeName}.log`
    );
  }
  env['WPF_HOTRELOAD_PIPE'] = pipeName;
  env['WPF_HOTRELOAD_START_HIDDEN'] = '0';
  env['ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO'] = '1';
  if (logFilePath) {
    env['WPF_HOTRELOAD_LOG'] = logFilePath;
  }

  if (helperAssemblyPath) {
    if (isFramework) {
      const helperDir = path.dirname(helperAssemblyPath);
      const helperDll = path.basename(helperAssemblyPath);
      const asmName = helperDll.replace(/\.dll$/i, '');
      env['APPDOMAIN_MANAGER_ASM'] = asmName;
      env['APPDOMAIN_MANAGER_TYPE'] = 'WpfHotReload.Runtime.FrameworkStartupHook';
      env['DEVPATH'] = helperDir;
      channel.appendLine(`[Runtime] Injecting helper via AppDomainManager for Framework: ${helperAssemblyPath}`);
    } else {
      env['DOTNET_STARTUP_HOOKS'] = helperAssemblyPath;
      channel.appendLine(`[Runtime] Injecting helper via DOTNET_STARTUP_HOOKS: ${helperAssemblyPath}`);
    }
  } else {
    channel.appendLine('[Runtime] Runtime helper build failed; hot reload will not be available.');
    return null;
  }
  channel.appendLine(`[Runtime] Pipe name: ${pipeName}`);
  if (logFilePath) {
    channel.appendLine(`[Runtime] Runtime log: ${logFilePath}`);
  }

  if (helperAssemblyPath && isFramework) {
    try {
      const staged = stageFrameworkRuntimeHelper(helperAssemblyPath, path.dirname(launchTarget.program));
      if (!staged.success) {
        channel.appendLine(`[Runtime] Framework helper staging completed with warnings: ${staged.errors.join(' | ')}`);
        vscode.window.showWarningMessage(
          'WPF hot reload could not fully stage the .NET Framework helper, but will try to continue.'
        );
      }
    } catch (err) {
      channel.appendLine(`[Runtime] Failed to stage framework helper: ${String(err)}`);
      vscode.window.showWarningMessage(
        'WPF hot reload could not stage the .NET Framework helper, but will try to continue.'
      );
    }
  }

  return {
    sessionKey,
    program: launchTarget.program,
    args: launchTarget.args,
    cwd: launchTarget.cwd,
    env,
    pipeName,
    logFilePath,
    helperAssemblyPath,
    isFramework,
    xamlPath,
  };
}

export async function startRuntimeHotReloadSession(
  context: vscode.ExtensionContext,
  projectPath: string,
  xamlPath?: string
): Promise<boolean> {
  const prep = await prepareHotReloadLaunch(context, projectPath, xamlPath);
  if (!prep) {
    // null means either reusing existing session or an error was shown.
    return runtimeSessionsByProject.has(toProjectSessionKey(projectPath));
  }

  const channel = getOutputChannel();
  channel.appendLine(`[Runtime] Launching ${prep.program} ${prep.args.join(' ')}`.trim());

  const child = cp.spawn(prep.program, prep.args, {
    cwd: prep.cwd,
    env: prep.env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    channel.append(chunk.toString());
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    channel.append(chunk.toString());
  });

  const info: RuntimeSessionInfo = {
    childProcess: child,
    projectPath,
    xamlPath: prep.xamlPath,
    warnedUnsupportedApply: false,
    pipeName: prep.pipeName,
    pipeReady: false,
    logFilePath: prep.logFilePath,
  };

  runtimeSessionsByProject.set(prep.sessionKey, info);
  channel.appendLine(`[Runtime] Started hot reload session for ${projectPath} (pid ${child.pid})`);

  child.on('exit', (code, signal) => {
    runtimeSessionsByProject.delete(prep.sessionKey);
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    channel.appendLine(`[Runtime] App exited (${reason}) for ${projectPath}`);
  });

  child.on('error', (err) => {
    runtimeSessionsByProject.delete(prep.sessionKey);
    channel.appendLine(`[Runtime] Failed to launch app: ${err.message}`);
    vscode.window.showErrorMessage(`Failed to launch WPF app: ${err.message}`);
  });

  return true;
}

/**
 * Starts a hot reload session with SharpDbg attached as a debugger.
 * The WPF app runs under SharpDbg (DAP), so you get breakpoints,
 * call stacks, and variable inspection alongside hot reload.
 */
export async function startRuntimeHotReloadSessionWithDebugger(
  context: vscode.ExtensionContext,
  projectPath: string,
  xamlPath?: string
): Promise<boolean> {
  const prep = await prepareHotReloadLaunch(context, projectPath, xamlPath);
  if (!prep) {
    return runtimeSessionsByProject.has(toProjectSessionKey(projectPath));
  }

  const channel = getOutputChannel();

  // Resolve SharpDbg adapter (native exe for .NET Framework, dotnet+DLL for Core/.NET).
  const adapter = resolveSharpDbgAdapter(prep.isFramework);
  if (!adapter) {
    // Offer to install SharpDbg from the Marketplace (respects suppression setting).
    await promptInstallSharpDbg(context);
    return false;
  }
  channel.appendLine(`[Runtime] Using SharpDbg adapter: ${adapter.command} ${adapter.args.join(' ')}`);

  // Build the env vars as a flat record for the debug launch config.
  // Only include values that are new/changed for this launch.
  const hotReloadEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(prep.env)) {
    if (value !== undefined && process.env[key] !== value) {
      hotReloadEnv[key] = value;
    }
  }
  // Always include hot-reload critical variables.
  hotReloadEnv['WPF_HOTRELOAD_PIPE'] = prep.pipeName;
  hotReloadEnv['ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO'] = '1';
  if (prep.env['DOTNET_STARTUP_HOOKS']) {
    hotReloadEnv['DOTNET_STARTUP_HOOKS'] = prep.env['DOTNET_STARTUP_HOOKS'];
  }
  if (prep.env['APPDOMAIN_MANAGER_ASM']) {
    hotReloadEnv['APPDOMAIN_MANAGER_ASM'] = prep.env['APPDOMAIN_MANAGER_ASM'];
  }
  if (prep.env['APPDOMAIN_MANAGER_TYPE']) {
    hotReloadEnv['APPDOMAIN_MANAGER_TYPE'] = prep.env['APPDOMAIN_MANAGER_TYPE'];
  }
  if (prep.env['DEVPATH']) {
    hotReloadEnv['DEVPATH'] = prep.env['DEVPATH'];
  }
  if (prep.logFilePath) {
    hotReloadEnv['WPF_HOTRELOAD_LOG'] = prep.logFilePath;
  }

  const debugConfig: vscode.DebugConfiguration = {
    type: 'wpf-sharpdbg',
    name: `WPF Hot Reload (Debug) — ${path.basename(projectPath)}`,
    request: 'launch',
    program: prep.program,
    args: prep.args,
    cwd: prep.cwd,
    env: hotReloadEnv,
    stopAtEntry: false,
    // Inform the debug adapter factory about the runtime type so it can pick the correct adapter.
    isFramework: prep.isFramework,
    projectPath: projectPath,
  };

  channel.appendLine(`[Runtime] Starting debug session for ${prep.program}`);

  // Register a listener to track the debug session lifecycle.
  const sessionKey = prep.sessionKey;
  const pipeName = prep.pipeName;
  const logFilePath = prep.logFilePath;

  const sessionStarted = new Promise<boolean>((resolve) => {
    const startListener = vscode.debug.onDidStartDebugSession((session) => {
      if (session.configuration.name !== debugConfig.name) {
        return;
      }
      startListener.dispose();

      // Create a synthetic child process handle for the session tracker.
      // We don't have a real ChildProcess, so create a minimal stand-in.
      const syntheticChild = new (require('events').EventEmitter)() as cp.ChildProcess;
      (syntheticChild as { pid: number | undefined }).pid = undefined;
      (syntheticChild as { killed: boolean }).killed = false;
      (syntheticChild as { exitCode: number | null }).exitCode = null;
      syntheticChild.kill = () => {
        vscode.debug.stopDebugging(session);
        return true;
      };

      const info: RuntimeSessionInfo = {
        childProcess: syntheticChild,
        projectPath,
        xamlPath: prep.xamlPath,
        warnedUnsupportedApply: false,
        pipeName,
        pipeReady: false,
        logFilePath,
      };

      runtimeSessionsByProject.set(sessionKey, info);
      channel.appendLine(`[Runtime] Debug session started for ${projectPath}`);

      const endListener = vscode.debug.onDidTerminateDebugSession((endedSession) => {
        if (endedSession !== session) {
          return;
        }
        endListener.dispose();
        runtimeSessionsByProject.delete(sessionKey);
        channel.appendLine(`[Runtime] Debug session ended for ${projectPath}`);
      });

      resolve(true);
    });

    // Timeout if the debug session doesn't start.
    setTimeout(() => {
      startListener.dispose();
      resolve(false);
    }, 15000);
  });

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const launched = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
  if (!launched) {
    channel.appendLine('[Runtime] Failed to start debug session.');
    vscode.window.showErrorMessage('Failed to start SharpDbg debug session for hot reload.');
    return false;
  }

  return sessionStarted;
}



export async function pushRuntimeXamlUpdate(
  projectPath: string,
  xamlPath: string,
  xamlText: string
): Promise<boolean> {
  const result = await pushRuntimeXamlUpdateDetailed(projectPath, xamlPath, xamlText);
  return result.success;
}

export async function pushRuntimeXamlUpdateDetailed(
  projectPath: string,
  xamlPath: string,
  xamlText: string
): Promise<RuntimePushResult> {
  getOutputChannel().appendLine(`[Runtime] Manual hot reload requested for ${xamlPath}`);
  const sessionKey = toProjectSessionKey(projectPath);
  const info = runtimeSessionsByProject.get(sessionKey);
  if (!info) {
    getOutputChannel().appendLine(`[Runtime] No running session found for ${projectPath}`);
    return {
      success: false,
      message: `no running session found for ${projectPath}`,
      degraded: false,
    };
  }

  info.xamlPath = xamlPath;

  if (!info.pipeReady) {
    const startupReady = await waitForRuntimePipeReady(info.pipeName, info.logFilePath);
    if (startupReady) {
      info.pipeReady = true;
      getOutputChannel().appendLine(`[Runtime] Runtime agent detected on pipe ${info.pipeName}.`);
    } else {
      getOutputChannel().appendLine(`[Runtime] Runtime agent not ready on pipe ${info.pipeName}. The app may still be starting.`);
      const logTail = readRuntimeLogTail(info.logFilePath);
      if (logTail) {
        getOutputChannel().appendLine('[Runtime] Last runtime log lines:');
        getOutputChannel().appendLine(logTail);
      }
      vscode.window.showWarningMessage(
        'WPF app is still starting. Wait for the app to load and try again.'
      );
      return {
        success: false,
        message: `runtime agent not ready on pipe ${info.pipeName}`,
        degraded: false,
      };
    }
  }

  // Classify the change for targeted patching.
  const fileKey = xamlPath.toLowerCase();
  const previousXaml = previousXamlByFile.get(fileKey);
  const classification = classifyXamlChange(previousXaml, xamlText);
  getOutputChannel().appendLine(`[Runtime] Change classified as: ${classification.changeKind} (${classification.propertyChanges.length} property changes)`);

  // Primary path: named pipe to the resident runtime agent.
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      getOutputChannel().appendLine(`[Runtime] Retrying pipe connection (attempt ${attempt + 1}/${maxAttempts})...`);
      await new Promise(r => setTimeout(r, 1000));
    }

    const pipeResult = await sendViaPipe(info.pipeName, xamlPath, xamlText, previousXaml, classification);
    if (pipeResult) {
      if (pipeResult.success) {
        info.pipeReady = true;
        previousXamlByFile.set(fileKey, xamlText);
        getOutputChannel().appendLine(`[Runtime] Applied XAML update via pipe for ${xamlPath}: ${pipeResult.message}`);
        const degraded = isDegradedApplyMessage(pipeResult.message);
        const stillHealthy = await verifySessionHealthyAfterApply(sessionKey, info.pipeName);
        if (!stillHealthy) {
          const failureMessage = `${pipeResult.message} | app exited shortly after apply`;
          getOutputChannel().appendLine(`[Runtime] Post-apply health check failed for ${xamlPath}: ${failureMessage}`);
          return { success: false, message: failureMessage, degraded };
        }

        return { success: true, message: pipeResult.message, degraded };
      }

      getOutputChannel().appendLine(`[Runtime] Pipe apply failed for ${xamlPath}: ${pipeResult.message}`);
      vscode.window.showWarningMessage(`WPF hot reload failed: ${pipeResult.message}`);
      return { success: false, message: pipeResult.message, degraded: false };
    }
  }

  info.pipeReady = false;
  getOutputChannel().appendLine(
    `[Runtime] Pipe unavailable after ${maxAttempts} attempts. Re-run Hot Reload to retry.`
  );
  vscode.window.showWarningMessage(
    'WPF hot reload runtime channel is not ready. Click Hot Reload again to retry.'
  );
  return {
    success: false,
    message: `pipe unavailable after ${maxAttempts} attempts`,
    degraded: false,
  };
}

function isDegradedApplyMessage(message: string): boolean {
  return message.includes('| full apply skipped:')
    || message.includes('| full apply failed:')
    || message.includes('xml fallback updated');
}

async function verifySessionHealthyAfterApply(sessionKey: string, pipeName: string): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = runtimeSessionsByProject.get(sessionKey);
    if (!session) {
      return false;
    }

    const child = session.childProcess;
    if (child.killed || child.exitCode !== null) {
      return false;
    }

    const probe = await sendPipeRequest(pipeName, { kind: 'query', query: 'agent.ready' });
    if (probe?.result === 'ok' && probe.value === '1') {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return false;
}

function sendViaPipe(
  pipeName: string,
  filePath: string,
  xamlText: string,
  previousXamlText?: string,
  classification?: XamlChangeClassification
): Promise<{ success: boolean; message: string } | null> {
  return new Promise(resolve => {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const client = net.createConnection(pipePath, () => {
      const payload: Record<string, unknown> = { filePath, xamlText };
      if (classification) {
        payload.changeKind = classification.changeKind;
        if (classification.propertyChanges.length > 0) {
          payload.propertyChanges = classification.propertyChanges;
        }
        if (previousXamlText) {
          payload.previousXamlText = previousXamlText;
        }
      }
      const request = JSON.stringify(payload) + '\n';
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

async function probeRuntimePipeReady(pipeName: string): Promise<boolean> {
  const response = await sendPipeRequest(pipeName, { kind: 'query', query: 'agent.ready' });
  return response?.result === 'ok' && response.value === '1';
}

async function waitForRuntimePipeReady(pipeName: string, logFilePath?: string): Promise<boolean> {
  const startedAt = Date.now();
  const timeoutMs = 15000;
  const retryDelayMs = 300;

  while (Date.now() - startedAt < timeoutMs) {
    if (await probeRuntimePipeReady(pipeName)) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }

  const logTail = readRuntimeLogTail(logFilePath);
  if (logTail) {
    getOutputChannel().appendLine('[Runtime] Runtime agent did not become ready within 15s.');
    getOutputChannel().appendLine(logTail);
  }

  return false;
}

function sendPipeRequest(
  pipeName: string,
  payload: Record<string, unknown>
): Promise<{ result?: string; value?: string } | null> {
  return new Promise(resolve => {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const client = net.createConnection(pipePath, () => {
      const request = JSON.stringify(payload) + '\n';
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

        const parsed = JSON.parse(line) as { result?: string; value?: string };
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });

    client.on('error', () => resolve(null));
    client.setTimeout(4000, () => {
      client.destroy();
      resolve(null);
    });
  });
}

async function ensureRuntimeHelperBuilt(
  sampleProjectPath: string,
  targetTfm: string,
  channel?: vscode.OutputChannel
): Promise<string | null> {
  if (!extensionPath) {
    return null;
  }

  const outputDir = path.join(extensionPath, 'tools', 'WpfHotReload.Runtime', targetTfm);
  const helperDll = path.join(outputDir, 'WpfHotReload.Runtime.dll');
  const projPath = path.join(extensionPath, 'src', 'WpfHotReload.Runtime', 'WpfHotReload.Runtime.csproj');
  if (!fs.existsSync(projPath)) {
    // Running from an installed .vsix — no source tree. Use the pre-built DLL.
    if (fs.existsSync(helperDll)) {
      return helperDll;
    }
    vscode.window.showErrorMessage('WPF hot reload runtime helper was not found.');
    return null;
  }

  if (isRuntimeHelperUpToDate(projPath, helperDll)) {
    return helperDll;
  }

  const logger = channel ?? getOutputChannel();
  const dotnetPath = vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet');
  logger.appendLine(`[Runtime] Building WPF hot reload helper (${targetTfm}) from ${projPath}`);

  const buildSucceeded = await new Promise<boolean>(resolve => {
    const args = [
      'build',
      projPath,
      '-c',
      'Debug',
      '-f',
      targetTfm,
      '-nologo',
      '-p:OutDir=' + `${outputDir}${path.sep}`,
    ];
    const proc = cp.spawn(dotnetPath, args, { shell: true, cwd: extensionPath });

    proc.stdout?.on('data', chunk => logger.append(chunk.toString()));
    proc.stderr?.on('data', chunk => logger.append(chunk.toString()));
    proc.on('error', () => resolve(false));
    proc.on('close', code => resolve(code === 0));
  });

  if (!buildSucceeded || !fs.existsSync(helperDll)) {
    vscode.window.showErrorMessage('Failed to build the WPF hot reload runtime helper.');
    return null;
  }

  return helperDll;
}

function resolveRuntimeHelperTargetFramework(projectTfm: string): string {
  const tfm = projectTfm.trim().toLowerCase();

  // Legacy .NET Framework (e.g. net462/net48) uses AppDomainManager injection.
  if (/^net\d{3,}$/.test(tfm) || /^net4/.test(tfm)) {
    return 'net462';
  }

  // For .NET Core/.NET 5+ WPF apps, use the lowest supported runtime helper
  // so one helper binary can serve from netcoreapp3.0 upward.
  if (tfm.startsWith('netcoreapp') || /^net\d+(\.\d+)?/.test(tfm)) {
    return 'netcoreapp3.0';
  }

  // Fallback to modern runtime path.
  return 'netcoreapp3.0';
}

function isRuntimeHelperUpToDate(projectPath: string, helperDllPath: string): boolean {
  if (!fs.existsSync(helperDllPath)) {
    return false;
  }

  const helperMtime = fs.statSync(helperDllPath).mtimeMs;
  const helperProjectDir = path.dirname(projectPath);
  const pending: string[] = [helperProjectDir];
  const watchedExtensions = new Set(['.cs', '.vb', '.fs', '.csproj', '.vbproj', '.fsproj', '.props', '.targets', '.resx']);

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

function stageFrameworkRuntimeHelper(
  helperAssemblyPath: string,
  destinationDir: string
): { success: boolean; errors: string[] } {
  const helperDir = path.dirname(helperAssemblyPath);
  const errors: string[] = [];

  fs.mkdirSync(destinationDir, { recursive: true });

  for (const entry of fs.readdirSync(helperDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = path.join(helperDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
      continue;
    }

    try {
      copyFileWithRetry(sourcePath, destinationPath);
    } catch (err) {
      errors.push(`${entry.name}: ${String(err)}`);
    }
  }

  return { success: errors.length === 0, errors };
}

function copyFileWithRetry(sourcePath: string, destinationPath: string): void {
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.copyFileSync(sourcePath, destinationPath);
      return;
    } catch (err) {
      if (attempt === attempts) {
        throw err;
      }

      const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code)) {
        throw err;
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function readRuntimeLogTail(logFilePath?: string): string | undefined {
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    return undefined;
  }

  try {
    const lines = fs.readFileSync(logFilePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-20).join('\n');
  } catch {
    return undefined;
  }
}

// ── XAML Diff Engine ────────────────────────────────────────────────────

const XAML_NS = 'http://schemas.microsoft.com/winfx/2006/xaml';

interface XmlElement {
  tag: string;
  attributes: Map<string, string>;
  children: XmlElement[];
  line: number;
  column: number;
}

/**
 * Minimal XML parser that extracts elements and their attributes for diffing.
 * Does not handle all XML edge cases — designed for well-formed XAML only.
 */
function parseXmlElements(text: string): XmlElement | null {
  // Use a regex-based approach for lightweight element+attribute extraction.
  // This avoids pulling in a full XML parser dependency.
  const elementPattern = /<([a-zA-Z_][\w:.]*)((?:\s+[\w:.]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const attrPattern = /([\w:.]+)\s*=\s*"([^"]*)"/g;
  const closingPattern = /<\/([a-zA-Z_][\w:.]*)\s*>/g;

  const root: XmlElement = { tag: '', attributes: new Map(), children: [], line: 0, column: 0 };
  const stack: XmlElement[] = [root];

  // Compute line/column for a given offset
  const lines = text.split('\n');
  function offsetToLineCol(offset: number): { line: number; column: number } {
    let remaining = offset;
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i].length) {
        return { line: i + 1, column: remaining + 1 };
      }
      remaining -= lines[i].length + 1;
    }
    return { line: lines.length, column: 1 };
  }

  // Interleave open/self-closing and closing tags by position
  type Token = { kind: 'open'; tag: string; attrs: Map<string, string>; selfClose: boolean; offset: number }
             | { kind: 'close'; tag: string; offset: number };
  const tokens: Token[] = [];

  let match: RegExpExecArray | null;
  while ((match = elementPattern.exec(text)) !== null) {
    const attrs = new Map<string, string>();
    let attrMatch: RegExpExecArray | null;
    const attrStr = match[2];
    while ((attrMatch = attrPattern.exec(attrStr)) !== null) {
      attrs.set(attrMatch[1], attrMatch[2]);
    }
    tokens.push({
      kind: 'open',
      tag: match[1],
      attrs,
      selfClose: match[3] === '/',
      offset: match.index,
    });
  }

  while ((match = closingPattern.exec(text)) !== null) {
    tokens.push({ kind: 'close', tag: match[1], offset: match.index });
  }

  tokens.sort((a, b) => a.offset - b.offset);

  for (const token of tokens) {
    if (token.kind === 'open') {
      const lc = offsetToLineCol(token.offset);
      const element: XmlElement = {
        tag: token.tag,
        attributes: token.attrs,
        children: [],
        line: lc.line,
        column: lc.column,
      };
      stack[stack.length - 1].children.push(element);
      if (!token.selfClose) {
        stack.push(element);
      }
    } else {
      // Close tag — pop stack if matching
      if (stack.length > 1 && stack[stack.length - 1].tag === token.tag) {
        stack.pop();
      }
    }
  }

  return root.children.length > 0 ? root.children[0] : null;
}

function getXName(element: XmlElement): string | undefined {
  return element.attributes.get('x:Name') ?? element.attributes.get('Name');
}

function getXClass(element: XmlElement): string | undefined {
  return element.attributes.get('x:Class');
}

export function classifyXamlChange(
  oldText: string | undefined,
  newText: string
): XamlChangeClassification {
  if (!oldText) {
    return { changeKind: 'fullFile', propertyChanges: [] };
  }

  const oldRoot = parseXmlElements(oldText);
  const newRoot = parseXmlElements(newText);

  if (!oldRoot || !newRoot) {
    return { changeKind: 'fullFile', propertyChanges: [] };
  }

  // x:Class changed → restart
  if (getXClass(oldRoot) !== getXClass(newRoot)) {
    return { changeKind: 'restart', propertyChanges: [] };
  }

  // Root tag changed → full file reload
  if (oldRoot.tag !== newRoot.tag) {
    return { changeKind: 'fullFile', propertyChanges: [] };
  }

  // Check if this is a ResourceDictionary
  if (oldRoot.tag === 'ResourceDictionary' || oldRoot.tag.endsWith(':ResourceDictionary')) {
    return { changeKind: 'resource', propertyChanges: [] };
  }

  // Walk and compare elements
  const propertyChanges: XamlPropertyChange[] = [];
  let hasStructuralChange = false;

  function compareElements(oldEl: XmlElement, newEl: XmlElement): void {
    if (oldEl.tag !== newEl.tag) {
      hasStructuralChange = true;
      return;
    }

    // Compare children count/structure
    if (oldEl.children.length !== newEl.children.length) {
      hasStructuralChange = true;
    }

    // Compare attributes — look for property changes
    const allKeys = new Set([...oldEl.attributes.keys(), ...newEl.attributes.keys()]);
    for (const key of allKeys) {
      const oldVal = oldEl.attributes.get(key);
      const newVal = newEl.attributes.get(key);
      if (oldVal !== newVal && newVal !== undefined) {
        // Skip namespace declarations and x: directives
        if (key.startsWith('xmlns') || key === 'x:Class' || key === 'x:Subclass') {
          continue;
        }
        const name = getXName(newEl) ?? '';
        propertyChanges.push({
          elementName: name,
          elementType: newEl.tag,
          property: key,
          newValue: newVal,
          line: newEl.line,
          column: newEl.column,
        });
      } else if (oldVal !== undefined && newVal === undefined) {
        // Attribute removed — structural change
        hasStructuralChange = true;
      }
    }

    // Recurse into children
    const minLen = Math.min(oldEl.children.length, newEl.children.length);
    for (let i = 0; i < minLen; i++) {
      compareElements(oldEl.children[i], newEl.children[i]);
    }
  }

  compareElements(oldRoot, newRoot);

  if (hasStructuralChange) {
    return { changeKind: 'subtree', propertyChanges };
  }

  if (propertyChanges.length > 0) {
    return { changeKind: 'property', propertyChanges };
  }

  // No detectable changes — send full file as safety net
  return { changeKind: 'fullFile', propertyChanges: [] };
}

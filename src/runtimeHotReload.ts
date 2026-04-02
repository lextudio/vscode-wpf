import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { areProjectOutputsUpToDate, getLaunchTarget, parseProject } from './projectDiscovery';
import { buildProject } from './designerLauncher';

interface RuntimeSessionInfo {
  childProcess: cp.ChildProcess;
  projectPath: string;
  xamlPath?: string;
  warnedUnsupportedApply: boolean;
  pipeName: string;
  pipeReady: boolean;
  logFilePath?: string;
}

let outputChannel: vscode.OutputChannel | undefined;
let extensionPath: string | undefined;

const runtimeSessionsByProject = new Map<string, RuntimeSessionInfo>();

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

export async function startRuntimeHotReloadSession(
  context: vscode.ExtensionContext,
  projectPath: string,
  xamlPath?: string
): Promise<boolean> {
  const sessionKey = toProjectSessionKey(projectPath);
  const channel = getOutputChannel();

  if (runtimeSessionsByProject.has(sessionKey)) {
    channel.appendLine(`[Runtime] Reusing existing session for ${projectPath}`);
    return true;
  }

  const { targetFramework } = parseProject(projectPath);
  const helperTargetTfm = resolveRuntimeHelperTargetFramework(targetFramework);
  const isFramework = helperTargetTfm === 'net462';

  const cfg = vscode.workspace.getConfiguration('wpf');
  const dotnetPath = cfg.get<string>('dotnetPath', 'dotnet');
  const autoBuild = getAutoBuildOnDesignerLaunch(cfg);

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
      return false;
    }
  }

  // Build the hot reload helper before launching so we can inject it
  // via DOTNET_STARTUP_HOOKS (Core) or AppDomainManager (Framework).
  const helperAssemblyPath = await ensureRuntimeHelperBuilt(projectPath, helperTargetTfm, channel);

  const launchTarget = getLaunchTarget(projectPath, dotnetPath);
  if (!launchTarget) {
    vscode.window.showErrorMessage(
      `Could not find a launchable output for ${path.basename(projectPath)}. Build the project first.`
    );
    return false;
  }

  const pipeName = `wpf-hotreload-${crypto.randomUUID()}`;
  const env: Record<string, string | undefined> = { ...process.env };
  const logFilePath = path.join(
    extensionPath ?? process.cwd(),
    '.logs',
    'wpf-hotreload',
    `${pipeName}.log`
  );
  env['WPF_HOTRELOAD_PIPE'] = pipeName;
  env['WPF_HOTRELOAD_START_HIDDEN'] = '0';
  env['WPF_HOTRELOAD_LOG'] = logFilePath;

  if (helperAssemblyPath) {
    if (isFramework) {
      // .NET Framework uses AppDomainManager for startup hooks.
      const helperDir = path.dirname(helperAssemblyPath);
      const helperDll = path.basename(helperAssemblyPath);
      const asmName = helperDll.replace(/\.dll$/i, '');
      env['APPDOMAIN_MANAGER_ASM'] = asmName;
      env['APPDOMAIN_MANAGER_TYPE'] = 'WpfHotReload.Runtime.FrameworkStartupHook';
      env['DEVPATH'] = helperDir; // Ensure CLR can find the helper assembly
      channel.appendLine(`[Runtime] Injecting helper via AppDomainManager for Framework: ${helperAssemblyPath}`);
    } else {
      // .NET Core/5+ uses DOTNET_STARTUP_HOOKS.
      env['DOTNET_STARTUP_HOOKS'] = helperAssemblyPath;
      channel.appendLine(`[Runtime] Injecting helper via DOTNET_STARTUP_HOOKS: ${helperAssemblyPath}`);
    }
  } else {
    channel.appendLine('[Runtime] Runtime helper build failed; hot reload will not be available.');
    return false;
  }
  channel.appendLine(`[Runtime] Pipe name: ${pipeName}`);
  channel.appendLine(`[Runtime] Runtime log: ${logFilePath}`);

  const program = launchTarget.program;
  const args = launchTarget.args;
  const cwd = launchTarget.cwd;

  if (helperAssemblyPath && isFramework) {
    try {
      const staged = stageFrameworkRuntimeHelper(helperAssemblyPath, path.dirname(program));
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

  channel.appendLine(`[Runtime] Launching ${program} ${args.join(' ')}`.trim());

  const child = cp.spawn(program, args, {
    cwd,
    env,
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
    xamlPath,
    warnedUnsupportedApply: false,
    pipeName,
    pipeReady: false,
    logFilePath,
  };

  runtimeSessionsByProject.set(sessionKey, info);
  channel.appendLine(`[Runtime] Started hot reload session for ${projectPath} (pid ${child.pid})`);

  child.on('exit', (code, signal) => {
    runtimeSessionsByProject.delete(sessionKey);
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    channel.appendLine(`[Runtime] App exited (${reason}) for ${projectPath}`);
  });

  child.on('error', (err) => {
    runtimeSessionsByProject.delete(sessionKey);
    channel.appendLine(`[Runtime] Failed to launch app: ${err.message}`);
    vscode.window.showErrorMessage(`Failed to launch WPF app: ${err.message}`);
  });

  return true;
}

export async function pushRuntimeXamlUpdate(
  projectPath: string,
  xamlPath: string,
  xamlText: string
): Promise<boolean> {
  getOutputChannel().appendLine(`[Runtime] Manual hot reload requested for ${xamlPath}`);
  const info = runtimeSessionsByProject.get(toProjectSessionKey(projectPath));
  if (!info) {
    getOutputChannel().appendLine(`[Runtime] No running session found for ${projectPath}`);
    return false;
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
      return false;
    }
  }

  // Primary path: named pipe to the resident runtime agent.
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      getOutputChannel().appendLine(`[Runtime] Retrying pipe connection (attempt ${attempt + 1}/${maxAttempts})...`);
      await new Promise(r => setTimeout(r, 1000));
    }

    const pipeResult = await sendViaPipe(info.pipeName, xamlPath, xamlText);
    if (pipeResult) {
      if (pipeResult.success) {
        info.pipeReady = true;
        getOutputChannel().appendLine(`[Runtime] Applied XAML update via pipe for ${xamlPath}: ${pipeResult.message}`);
        return true;
      }

      getOutputChannel().appendLine(`[Runtime] Pipe apply failed for ${xamlPath}: ${pipeResult.message}`);
      vscode.window.showWarningMessage(`WPF hot reload failed: ${pipeResult.message}`);
      return false;
    }
  }

  info.pipeReady = false;
  getOutputChannel().appendLine(
    `[Runtime] Pipe unavailable after ${maxAttempts} attempts. Re-run Hot Reload to retry.`
  );
  vscode.window.showWarningMessage(
    'WPF hot reload runtime channel is not ready. Click Hot Reload again to retry.'
  );
  return false;
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

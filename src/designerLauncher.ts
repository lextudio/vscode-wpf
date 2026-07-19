import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { parseProject } from './projectDiscovery';
import { getSharpDbgApi } from './sharpdbgAdapter';

export interface BuildResult {
  success: boolean;
  output: string;
}

/** File written next to the designer binary recording which TFM it was built for. */
const DESIGNER_TFM_FILE = 'designer.tfm';
const MODERN_DESIGNER_DIR = 'XamlDesigner';
const LEGACY_DESIGNER_DIR = 'XamlDesignerLegacy';
const DEFAULT_LIBREWPF_TFM = 'net10.0-windows';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('WPF Designer');
  }
  return outputChannel;
}

interface DesignerSession {
  proc: cp.ChildProcess;
  pipeName: string;
  callbackServer: net.Server;
  lastXamlPath?: string;
}

export interface DesignerSessionInfo {
  projectPath: string;
  pipeName: string;
  pid: number | null;
  lastXamlPath: string | null;
}

interface DesignerPipeMessage {
  command: 'openFile' | 'applyXamlText';
  path: string;
  xamlText?: string;
}

export interface DesignerCallbackMessage {
  command: string;
  xamlPath: string;
  handlerName: string;
  eventName: string;
  eventArgType: string;
}

// Track one designer session per project path.
const activeDesigners = new Map<string, DesignerSession>();

let eventHandlerCallback: ((msg: DesignerCallbackMessage) => void) | undefined;

export function setEventHandlerCallback(cb: (msg: DesignerCallbackMessage) => void): void {
  eventHandlerCallback = cb;
}

function createCallbackServer(pipeName: string): net.Server {
  const pipePath = getDesignerPipePath(pipeName);
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(pipePath); } catch { /* stale socket may not exist */ }
  }

  const server = net.createServer(socket => {
    let data = '';
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => {
      try {
        const msg = JSON.parse(data) as DesignerCallbackMessage;
        if (msg.command === 'createEventHandler') {
          eventHandlerCallback?.(msg);
        }
      } catch {
        // Ignore malformed messages.
      }
    });
    socket.on('error', () => { /* connection errors are non-fatal */ });
  });
  server.listen(pipePath);
  return server;
}

function getDesignerPipePath(pipeName: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}`
    : path.join(os.tmpdir(), `CoreFxPipe_${pipeName}`);
}

function getDotnetSdkEnvironment(dotnet: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const dotnetBinDir = path.dirname(dotnet);
  let dotnetRoot: string | undefined;

  if (fs.existsSync(path.join(dotnetBinDir, 'sdk'))) {
    dotnetRoot = dotnetBinDir;
  } else {
    const homebrewLibexec = path.resolve(dotnetBinDir, '..', 'libexec');
    if (fs.existsSync(path.join(homebrewLibexec, 'sdk'))) {
      dotnetRoot = homebrewLibexec;
    }
  }

  if (!dotnetRoot) {
    return env;
  }

  const sdkRoot = path.join(dotnetRoot, 'sdk');
  const sdkDirs = fs.readdirSync(sdkRoot)
    .map(name => path.join(sdkRoot, name))
    .filter(p => fs.statSync(p).isDirectory())
    .sort();
  const sdkDir = sdkDirs[sdkDirs.length - 1];
  if (!sdkDir) {
    return env;
  }

  env.DOTNET_ROOT = dotnetRoot;
  env.DOTNET_HOST_PATH = dotnet;
  env.MSBuildSDKsPath = path.join(sdkDir, 'Sdks');
  env.MSBuildExtensionsPath = sdkDir;
  env.MSBUILDADDITIONALSDKRESOLVERSFOLDER_NET = path.join(sdkDir, 'SdkResolvers');
  env.MSBUILD_NUGET_PATH = sdkDir;
  env.MSBuildEnableWorkloadResolver = 'false';
  return env;
}

function getDesignerLaunchEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_')) {
      delete env[key];
    }
  }

  return env;
}

function getDesignerStdioOptions(): cp.StdioOptions {
  const logPath = process.env.WPF_DESIGNER_PROCESS_LOG;
  if (!logPath) {
    return 'ignore';
  }

  try {
    const fd = fs.openSync(logPath, 'a');
    return ['ignore', fd, fd];
  } catch {
    return 'ignore';
  }
}

function getDesignerBuildDotnet(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration('wpf').get<string>('libreWpfDotnetPath', '').trim();
  if (configured) {
    return configured;
  }

  return vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet');
}

// ---------------------------------------------------------------------------
// TFM helpers
// ---------------------------------------------------------------------------

/**
 * Parse the major version number from a .NET (Core/5+) TFM string.
 * Returns null for .NET Framework monikers (net4x) or unrecognised strings.
 *
 * Examples:
 *   "net10.0-windows" → 10
 *   "net6.0"          → 6
 *   "net48"           → null  (Framework)
 *   "netstandard2.0"  → null  (not a runnable TFM)
 */
function parseDotnetMajor(tfm: string): number | null {
  const m = /^net(\d+)\.(\d+)/i.exec(tfm);
  if (!m) { return null; }
  const major = parseInt(m[1], 10);
  return major >= 5 ? major : null; // net4x → Framework → null
}

function isFrameworkTfm(tfm: string): boolean {
  return /^net\d{2,}$/i.test(tfm) || /^net4/i.test(tfm);
}

/**
 * Returns true when .NET Framework 4.8.1 or later is installed on this machine.
 * Reads the registry release DWORD; the 4.8.1 minimum is 533320.
 * Returns false on non-Windows platforms or if the registry key is absent.
 */
function isDotNetFramework481Installed(): boolean {
  if (process.platform !== 'win32') { return false; }
  try {
    const output = cp.execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full" /v Release',
      { encoding: 'utf8', stdio: 'pipe', timeout: 3000 }
    );
    const m = /Release\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
    if (m) {
      return parseInt(m[1], 16) >= 533320; // 4.8.1 minimum
    }
  } catch { /* registry key absent or command failed */ }
  return false;
}

/**
 * Query `dotnet --list-sdks` and return the highest net-X.0-windows TFM
 * available on this machine, e.g. "net10.0-windows".
 * Returns null if dotnet is not found or no SDK >= 5 is installed.
 */
async function detectHighestDotnetSdkTfm(dotnetCmd: string): Promise<string | null> {
  return new Promise(resolve => {
    const proc = cp.spawn(dotnetCmd, ['--list-sdks'], { shell: true });
    let output = '';
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', () => {
      const majors = output
        .split('\n')
        .map(line => { const m = /^(\d+)\.\d+\.\d+/.exec(line.trim()); return m ? parseInt(m[1], 10) : null; })
        .filter((v): v is number => v !== null && v >= 5);

      if (majors.length === 0) { resolve(null); return; }
      const highest = Math.max(...majors);
      resolve(`net${highest}.0-windows`);
    });
    proc.on('error', () => resolve(null));
  });
}

/** Read the TFM that a bundled designer variant was last built for. */
function getBuiltDesignerTfm(context: vscode.ExtensionContext, toolsSubdir = MODERN_DESIGNER_DIR): string | null {
  const tfmFile = path.join(context.extensionPath, 'tools', toolsSubdir, DESIGNER_TFM_FILE);
  try {
    return fs.readFileSync(tfmFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Write the TFM after a successful designer build. */
function writeDesignerTfm(outDir: string, tfm: string): void {
  try {
    fs.writeFileSync(path.join(outDir, DESIGNER_TFM_FILE), tfm, 'utf8');
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Public: compatibility check
// ---------------------------------------------------------------------------

export interface CompatibilityResult {
  /** Whether it is safe to launch the designer with this project's assemblies. */
  compatible: boolean;
  /** Human-readable explanation when not compatible. */
  message: string;
  /** True when the problem can be fixed by rebuilding the designer. */
  canRebuild: boolean;
}

/**
 * Compare the project's target framework against the framework the designer
 * was built for and return a compatibility verdict.
 */
export function checkDesignerCompatibility(
  projectPath: string,
  context: vscode.ExtensionContext
): CompatibilityResult {
  const { targetFramework: projectTfm } = parseProject(projectPath);
  const modernDesignerExe = getBundledDesignerExecutable(context, MODERN_DESIGNER_DIR);
  const modernDesignerTfm = getBuiltDesignerTfm(context, MODERN_DESIGNER_DIR);
  const legacyDesignerExe = getLegacyDesignerExecutable(context);
  const legacyDesignerTfm = getBuiltDesignerTfm(context, LEGACY_DESIGNER_DIR);

  if (isFrameworkTfm(projectTfm)) {
    if (legacyDesignerExe) {
      if (!isDotNetFramework481Installed()) {
        return {
          compatible: false,
          canRebuild: false,
          message:
            `This project targets .NET Framework (${projectTfm}). ` +
            `The staged designer targets ${legacyDesignerTfm ?? 'net481'}, but .NET Framework 4.8.1 ` +
            `is not installed on this machine. Install it to use the designer with full type support.`,
        };
      }
      return { compatible: true, message: '', canRebuild: false };
    }

    return {
      compatible: false,
      canRebuild: true,
      message:
        `This project targets .NET Framework (${projectTfm}). ` +
        `The packaged net481 designer is missing. Build the Designer Tools to stage both the modern and net481 variants, ` +
        `or launch anyway to open the XAML without custom type support.`,
    };
  }

  if (!modernDesignerExe) {
    return {
      compatible: false,
      canRebuild: true,
      message:
        'The packaged modern .NET designer is missing. Build the Designer Tools to stage both designer variants before launching.',
    };
  }

  if (!modernDesignerTfm) {
    // No TFM file — old build or user-supplied exe; allow with a caveat.
    return { compatible: true, message: '', canRebuild: false };
  }

  const projectMajor = parseDotnetMajor(projectTfm);
  const designerMajor = parseDotnetMajor(modernDesignerTfm);

  if (projectMajor === null || designerMajor === null) {
    return { compatible: true, message: '', canRebuild: false };
  }

  if (projectMajor > designerMajor) {
    return {
      compatible: false,
      canRebuild: true,
      message:
        `Project targets ${projectTfm} but the designer was built for ${modernDesignerTfm}. ` +
        `The designer process cannot load assemblies from a newer runtime.`,
    };
  }

  return { compatible: true, message: '', canRebuild: false };
}

// ---------------------------------------------------------------------------
// Build project
// ---------------------------------------------------------------------------

/**
 * Build the .NET project using `dotnet build` (SDK-style) or fall back to
 * `msbuild` for legacy non-SDK projects.
 */
export async function buildProject(
  projectPath: string,
  token?: vscode.CancellationToken
): Promise<BuildResult> {
  const channel = getOutputChannel();
  channel.show(true);

  const cfg = vscode.workspace.getConfiguration('wpf');
  const dotnet = cfg.get<string>('dotnetPath', 'dotnet');
  const configuration = cfg.get<string>('buildConfiguration', 'Debug');

  channel.appendLine(`\n=== Building ${path.basename(projectPath)} ===`);
  channel.appendLine(`  Configuration : ${configuration}`);

  const isSdkStyle = isSdkStyleProject(projectPath);
  let cmd: string;
  let args: string[];
  if (isSdkStyle) {
    cmd = dotnet;
    args = ['build', projectPath, '--configuration', configuration, '--nologo', '-v', 'm'];
  } else {
    cmd = await findMsBuildExe() ?? 'msbuild';
    args = [projectPath, `/p:Configuration=${configuration}`, '/nologo', '/v:m'];
  }

  channel.appendLine(`  Command       : ${cmd} ${args.join(' ')}\n`);

  return new Promise<BuildResult>(resolve => {
    let output = '';
    const proc = cp.spawn(cmd, args, { shell: false });

    if (token) {
      token.onCancellationRequested(() => {
        proc.kill();
        resolve({ success: false, output: 'Build cancelled.' });
      });
    }

    proc.stdout?.on('data', (d: Buffer) => { const s = d.toString(); output += s; channel.append(s); });
    proc.stderr?.on('data', (d: Buffer) => { const s = d.toString(); output += s; channel.append(s); });

    proc.on('close', (code: number | null) => {
      const success = code === 0;
      channel.appendLine(success ? '\nBuild succeeded.' : `\nBuild FAILED (exit code ${code}).`);
      if (!success && isSdkMissing(output)) {
        vscode.window.showWarningMessage(
          'A .NET SDK is required to build this WPF project. Install .NET 10 SDK or set wpf.dotnetPath to a dotnet host that has the SDK.'
        );
      }
      resolve({ success, output });
    });

    proc.on('error', (err: Error) => {
      const msg = `Failed to start build process: ${err.message}`;
      channel.appendLine(msg);
      resolve({ success: false, output: msg });
    });
  });
}

// ---------------------------------------------------------------------------
// Designer executable resolution
// ---------------------------------------------------------------------------

export function getDesignerExecutable(context: vscode.ExtensionContext, projectPath?: string): string | null {
  const override = vscode.workspace.getConfiguration('wpf').get<string>('designerExecutable', '');
  if (override && fs.existsSync(override)) { return override; }

  if (projectPath) {
    const { targetFramework: tfm } = parseProject(projectPath);
    if (isFrameworkTfm(tfm) && isDotNetFramework481Installed()) {
      const legacyExe = getLegacyDesignerExecutable(context);
      if (legacyExe) { return legacyExe; }
    }
  }

  return getBundledDesignerExecutable(context, MODERN_DESIGNER_DIR);
}

function getBundledDesignerExecutable(context: vscode.ExtensionContext, toolsSubdir: string): string | null {
  const toolsDir = path.join(context.extensionPath, 'tools', toolsSubdir);

  for (const name of ['XamlDesigner.exe', 'Demo.XamlDesigner.exe', 'XamlDesigner.dll', 'Demo.XamlDesigner.dll']) {
    const p = path.join(toolsDir, name);
    if (fs.existsSync(p)) { return p; }
  }

  try {
    const files = fs.readdirSync(toolsDir);
    for (const f of files) {
      if (/\.exe$/i.test(f)) { return path.join(toolsDir, f); }
    }
    for (const f of files) {
      if (/\.dll$/i.test(f) && !f.endsWith('.resources.dll')) { return path.join(toolsDir, f); }
    }
  } catch { /* ignore */ }

  return null;
}

function getLegacyDesignerExecutable(context: vscode.ExtensionContext): string | null {
  return getBundledDesignerExecutable(context, LEGACY_DESIGNER_DIR);
}
// ---------------------------------------------------------------------------
// Launch designer
// ---------------------------------------------------------------------------

export function launchDesigner(
  xamlPath: string,
  assemblies: string[],
  context: vscode.ExtensionContext,
  projectPath: string,
  xamlText?: string
): void {
  const existing = activeDesigners.get(projectPath);
  if (existing && !existing.proc.killed) {
    existing.lastXamlPath = xamlPath;
    sendDesignerMessage(existing.pipeName, createDesignerMessage(xamlPath, xamlText));
    return;
  }

  const exe = getDesignerExecutable(context, projectPath);
  if (!exe) {
    vscode.window
      .showErrorMessage('XamlDesigner.exe not found. Run "WPF: Build Designer Tools" to build it.', 'Build Designer Tools')
      .then(action => { if (action === 'Build Designer Tools') { vscode.commands.executeCommand('wpf.buildDesignerTools'); } });
    return;
  }

  const pipeName = `XamlDesigner-${Date.now()}`;
  const callbackPipeName = `XamlDesigner-cb-${Date.now()}`;
  const callbackServer = createCallbackServer(callbackPipeName);
  const args = ['--pipe', pipeName, '--callback', callbackPipeName, xamlPath, ...assemblies];
  const channel = getOutputChannel();
  channel.appendLine(`\n=== Launching Designer ===`);
  channel.appendLine(`  Exe      : ${exe}`);
  channel.appendLine(`  Pipe     : ${pipeName}`);
  channel.appendLine(`  Args     : ${args.slice(2).join('\n             ')}\n`);

  // NewFileTemplate.xaml is read with a bare relative path inside the designer —
  // working directory must be the exe's own folder.
  const cwd = path.dirname(exe);
  const stdio = getDesignerStdioOptions();

  let proc: cp.ChildProcess;
  if (/\.dll$/i.test(exe)) {
    const dotnet = vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet');
    proc = cp.spawn(dotnet, [exe, ...args], {
      cwd,
      shell: false,
      detached: true,
      env: getDesignerLaunchEnvironment(),
      stdio,
      windowsHide: false,
    });
  } else {
    proc = cp.spawn(exe, args, {
      cwd,
      detached: true,
      env: getDesignerLaunchEnvironment(),
      stdio,
      windowsHide: false,
    });
  }

  proc.unref();

  proc.on('error', (err: Error) => {
    vscode.window.showErrorMessage(`Failed to launch designer: ${err.message}`);
    activeDesigners.delete(projectPath);
  });

  proc.on('close', (code: number | null) => {
    callbackServer.close();
    activeDesigners.delete(projectPath);
    if (code !== 0 && code !== null) {
      channel.appendLine(`Designer exited with code ${code}.`);
    }
  });

  activeDesigners.set(projectPath, { proc, pipeName, callbackServer, lastXamlPath: xamlPath });

  if (xamlText) {
    void sendDesignerMessageWithRetry(pipeName, createDesignerMessage(xamlPath, xamlText));
  }
}

export function hasRunningDesignerSession(projectPath: string): boolean {
  const session = activeDesigners.get(projectPath);
  return !!session && !session.proc.killed;
}

export function getDesignerSessionInfo(projectPath: string): DesignerSessionInfo | null {
  const session = activeDesigners.get(projectPath);
  if (!session || session.proc.killed) {
    return null;
  }

  return {
    projectPath,
    pipeName: session.pipeName,
    pid: session.proc.pid ?? null,
    lastXamlPath: session.lastXamlPath ?? null,
  };
}

export function pushLiveXamlUpdate(projectPath: string, xamlPath: string, xamlText: string): void {
  const session = activeDesigners.get(projectPath);
  if (!session || session.proc.killed) {
    return;
  }

  session.lastXamlPath = xamlPath;
  sendDesignerMessage(session.pipeName, createDesignerMessage(xamlPath, xamlText));
}

export function restartDesignerSession(projectPath: string): void {
  const session = activeDesigners.get(projectPath);
  if (!session) {
    return;
  }

  try {
    if (!session.proc.killed) {
      session.proc.kill();
    }
  } catch {
    // Best effort: remove stale session even if the process is already gone.
  }

  session.callbackServer.close();
  activeDesigners.delete(projectPath);
}

function createDesignerMessage(xamlPath: string, xamlText?: string): DesignerPipeMessage {
  return xamlText
    ? { command: 'applyXamlText', path: xamlPath, xamlText }
    : { command: 'openFile', path: xamlPath };
}

function sendDesignerMessage(pipeName: string, message: DesignerPipeMessage): void {
  const pipePath = getDesignerPipePath(pipeName);
  const client = net.createConnection(pipePath, () => {
    client.write(JSON.stringify(message), () => client.end());
  });
  client.on('error', (err: Error) => {
    vscode.window.showErrorMessage(`Failed to send command to running designer: ${err.message}`);
  });
}

async function sendDesignerMessageWithRetry(
  pipeName: string,
  message: DesignerPipeMessage,
  attempts = 12,
  delayMs = 250
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await trySendDesignerMessage(pipeName, message);
      return;
    } catch {
      if (attempt === attempts - 1) {
        vscode.window.showWarningMessage(
          'The designer launched, but live XAML sync did not connect. The designer is showing the last saved file contents.'
        );
        return;
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

function trySendDesignerMessage(pipeName: string, message: DesignerPipeMessage): Promise<void> {
  const pipePath = getDesignerPipePath(pipeName);
  return new Promise((resolve, reject) => {
    const client = net.createConnection(pipePath, () => {
      client.write(JSON.stringify(message), err => {
        if (err) {
          reject(err);
          client.destroy();
          return;
        }

        client.end();
      });
    });

    client.on('end', () => resolve());
    client.on('close', hadError => {
      if (!hadError) {
        resolve();
      }
    });
    client.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Build designer tools
// ---------------------------------------------------------------------------

export async function buildDesignerTools(context: vscode.ExtensionContext): Promise<void> {
  const channel = getOutputChannel();
  channel.show(true);

  const submoduleCsproj = path.join(
    context.extensionPath, 'external', 'WpfDesigner', 'XamlDesigner', 'Demo.XamlDesigner.csproj'
  );

  if (!fs.existsSync(submoduleCsproj)) {
    channel.appendLine('ERROR: WpfDesigner submodule not found.');
    channel.appendLine('  Run: git submodule update --init --recursive');
    vscode.window.showErrorMessage('WpfDesigner submodule not initialised. Run: git submodule update --init --recursive');
    return;
  }

  const outDir = path.join(context.extensionPath, 'tools', 'XamlDesigner');

  const cfg = vscode.workspace.getConfiguration('wpf');
  const dotnet = getDesignerBuildDotnet(context);
  const buildEnv = getDotnetSdkEnvironment(dotnet);

  // LibreWPF currently exposes the designer WPF surface through net10.0-windows packages.
  const settingTfm = cfg.get<string>('designerTargetFramework', '').trim();
  const targetFramework = settingTfm || DEFAULT_LIBREWPF_TFM;
  const legacyTfm = 'net481';
  const includeLegacy = process.platform === 'win32';
  const frameworks = includeLegacy && targetFramework !== legacyTfm
    ? [targetFramework, legacyTfm]
    : [targetFramework];
  const targetFrameworksArg = frameworks.join(';');

  channel.appendLine(`\n=== Building XamlDesigner ===`);
  channel.appendLine(`  Dotnet           : ${dotnet}`);
  channel.appendLine(`  Output           : ${outDir}`);
  channel.appendLine(`  TargetFrameworks : ${targetFrameworksArg}\n`);

  // Restore and build every requested TFM together in one multi-target pass — Directory.Build.props
  // in the WpfDesigner submodule sets TargetFrameworks from XamlDesignerDefaultTargetFrameworks.
  // Two sequential single-TFM restore/build passes against the same obj/ cache (the previous
  // approach) can leave a stale project.assets.json missing whichever TFM wasn't built last,
  // causing NETSDK1005 on the next run. --force on restore additionally guards against NuGet's
  // incremental no-op path reusing a still-stale assets file across setting changes.
  let buildSucceeded = false;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Building WPF Designer Tools…', cancellable: false },
    async () => {
      await new Promise<void>(resolve => {
        void stopConflictingDesignerProcesses(dotnet, channel).then(() => {
          const restoreProc = cp.spawn(
            dotnet,
            ['restore', submoduleCsproj, '--nologo', '--force', '-p:UseSharedCompilation=false',
              `-p:XamlDesignerDefaultTargetFrameworks=${targetFrameworksArg}`, '-p:EnableWindowsTargeting=true'],
            { shell: true, env: buildEnv }
          );
          restoreProc.stdout?.on('data', (d: Buffer) => channel.append(d.toString()));
          restoreProc.stderr?.on('data', (d: Buffer) => channel.append(d.toString()));

          restoreProc.on('error', (err: Error) => {
            channel.appendLine(`ERROR: ${err.message}`);
            vscode.window.showErrorMessage(`Restore error: ${err.message}`);
            resolve();
          });

          restoreProc.on('close', (restoreCode: number | null) => {
            if (restoreCode !== 0) {
              channel.appendLine(`\nRestore FAILED (exit code ${restoreCode}).`);
              vscode.window.showErrorMessage('Failed to restore WPF Designer Tools. See "WPF Designer" output channel.');
              resolve();
              return;
            }

            const proc = cp.spawn(
              dotnet,
              ['build', submoduleCsproj, '--configuration', 'Release',
                '--nologo', '--no-restore', '-maxcpucount:1', '-p:UseSharedCompilation=false',
                `-p:XamlDesignerDefaultTargetFrameworks=${targetFrameworksArg}`, '-p:EnableWindowsTargeting=true'],
              { shell: true, env: buildEnv }
            );

            proc.stdout?.on('data', (d: Buffer) => channel.append(d.toString()));
            proc.stderr?.on('data', (d: Buffer) => channel.append(d.toString()));

            proc.on('close', (code: number | null) => {
              if (code === 0) {
                buildSucceeded = true;
                channel.appendLine(`\nBuild succeeded for ${targetFrameworksArg}.`);
              } else {
                channel.appendLine(`\nBuild FAILED (exit code ${code}).`);
                vscode.window.showErrorMessage('Failed to build WPF Designer Tools. See "WPF Designer" output channel.');
              }
              resolve();
            });

            proc.on('error', (err: Error) => {
              channel.appendLine(`ERROR: ${err.message}`);
              vscode.window.showErrorMessage(`Build error: ${err.message}`);
              resolve();
            });
          });
        });
      });
    }
  );

  if (!buildSucceeded) {
    return;
  }

  const builtOutputDir = path.join(
    context.extensionPath, 'external', 'WpfDesigner', 'XamlDesigner', 'bin', 'Release', targetFramework
  );
  try {
    syncBuiltDesignerOutput(builtOutputDir, outDir);
  } catch (err) {
    channel.appendLine(`ERROR: Failed to stage built designer artifacts: ${err}`);
    vscode.window.showErrorMessage('Designer build succeeded, but staging the output failed. See "WPF Designer" output channel.');
    return;
  }
  writeDesignerTfm(outDir, targetFramework);
  channel.appendLine(`\nDesigner tools staged (${targetFramework}).`);

  if (includeLegacy) {
    const legacyOutDir = path.join(context.extensionPath, 'tools', LEGACY_DESIGNER_DIR);
    const legacyBuiltDir = path.join(
      context.extensionPath, 'external', 'WpfDesigner', 'XamlDesigner', 'bin', 'Release', legacyTfm
    );
    try {
      syncBuiltDesignerOutput(legacyBuiltDir, legacyOutDir);
      writeDesignerTfm(legacyOutDir, legacyTfm);
      channel.appendLine(`.NET Framework designer staged (${legacyTfm}).`);
    } catch (err) {
      channel.appendLine(`ERROR: Failed to stage ${legacyTfm} artifacts: ${err}`);
      vscode.window.showWarningMessage(
        'Built the LibreWPF designer, but failed to stage net481 legacy designer artifacts. .NET Framework projects will not have full designer type support.'
      );
    }
  }

  vscode.window.showInformationMessage(`WPF Designer Tools built with LibreWPF (${targetFramework}).`);
}

function syncBuiltDesignerOutput(sourceDir: string, destinationDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Built output directory not found: ${sourceDir}`);
  }

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function stopConflictingDesignerProcesses(dotnet: string, channel: vscode.OutputChannel): Promise<void> {
  if (process.platform !== 'win32') {
    return new Promise(resolve => {
      const shutdown = cp.spawn(dotnet, ['build-server', 'shutdown'], { shell: true });
      shutdown.on('close', () => {
        channel.appendLine('[Designer] Shut down dotnet build servers.');
        resolve();
      });
      shutdown.on('error', () => resolve());
    });
  }

  const imageNames = [
    'VBCSCompiler.exe',
    'XamlDesigner.exe',
    'Demo.XamlDesigner.exe',
  ];

  const taskkillImage = (imageName: string): Promise<void> => new Promise(resolve => {
    const proc = cp.spawn('taskkill', ['/F', '/IM', imageName], { shell: false });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });

  return new Promise(resolve => {
    const shutdown = cp.spawn(dotnet, ['build-server', 'shutdown'], { shell: true });
    const finish = async (): Promise<void> => {
      await Promise.all(imageNames.map(taskkillImage));
      channel.appendLine('[Designer] Cleared conflicting build/design processes.');
      resolve();
    };

    shutdown.on('close', () => { void finish(); });
    shutdown.on('error', () => { void finish(); });
  });
}

function isSdkMissing(output: string): boolean {
  return /No SDKs were found/i.test(output) ||
    /A compatible installed \.NET SDK for global\.json version/i.test(output) ||
    /It was not possible to find any installed \.NET SDKs/i.test(output) ||
    /The application 'build' does not exist/i.test(output);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSdkStyleProject(projectPath: string): boolean {
  try {
    const head = fs.readFileSync(projectPath, 'utf8').slice(0, 512);
    return /\<Project\s+Sdk\s*=/i.test(head);
  } catch {
    return true;
  }
}

/**
 * Use the SharpDbg extension API to locate MSBuild.exe from the latest Visual
 * Studio installation. SharpDbg is a declared extensionDependency so its API
 * is always available when this extension is active.
 */
async function findMsBuildExe(): Promise<string | null> {
  const api = getSharpDbgApi();
  if (!api) {
    return null;
  }
  return (await api.findMsBuildExe()) ?? null;
}

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { parseProject } from './projectDiscovery';

export interface BuildResult {
  success: boolean;
  output: string;
}

/** File written next to the designer binary recording which TFM it was built for. */
const DESIGNER_TFM_FILE = 'designer.tfm';

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
  server.listen(`\\\\.\\pipe\\${pipeName}`);
  return server;
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

/** Read the TFM that the bundled designer was last built for. */
function getBuiltDesignerTfm(context: vscode.ExtensionContext): string | null {
  const tfmFile = path.join(context.extensionPath, 'tools', 'XamlDesigner', DESIGNER_TFM_FILE);
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

  // .NET Framework projects — different runtime, cannot load into .NET Core designer.
  if (isFrameworkTfm(projectTfm)) {
    return {
      compatible: false,
      canRebuild: false,
      message:
        `This project targets .NET Framework (${projectTfm}). ` +
        `The designer runs on .NET Core and cannot load .NET Framework assemblies. ` +
        `The XAML will open without custom type support.`,
    };
  }

  const designerTfm = getBuiltDesignerTfm(context);
  if (!designerTfm) {
    // No TFM file — old build or user-supplied exe; allow with a caveat.
    return { compatible: true, message: '', canRebuild: false };
  }

  const projectMajor = parseDotnetMajor(projectTfm);
  const designerMajor = parseDotnetMajor(designerTfm);

  if (projectMajor === null || designerMajor === null) {
    return { compatible: true, message: '', canRebuild: false };
  }

  if (projectMajor > designerMajor) {
    return {
      compatible: false,
      canRebuild: true,
      message:
        `Project targets ${projectTfm} but the designer was built for ${designerTfm}. ` +
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
    const proc = cp.spawn(cmd, args, { shell: true });

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

export function getDesignerExecutable(context: vscode.ExtensionContext): string | null {
  const override = vscode.workspace.getConfiguration('wpf').get<string>('designerExecutable', '');
  if (override && fs.existsSync(override)) { return override; }

  const toolsDir = path.join(context.extensionPath, 'tools', 'XamlDesigner');

  for (const name of ['XamlDesigner.exe', 'Demo.XamlDesigner.exe']) {
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

  const exe = getDesignerExecutable(context);
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

  let proc: cp.ChildProcess;
  if (/\.dll$/i.test(exe)) {
    const dotnet = vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet');
    proc = cp.spawn(dotnet, [exe, ...args], { cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: false });
  } else {
    proc = cp.spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
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
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
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
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
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
  const submoduleRoot = path.join(context.extensionPath, 'external', 'WpfDesigner');
  const tempProps = path.join(submoduleRoot, 'Directory.Build.props');

  const cfg = vscode.workspace.getConfiguration('wpf');
  const dotnet = cfg.get<string>('dotnetPath', 'dotnet');

  // Resolve target framework: explicit setting → auto-detect highest SDK → fallback.
  const settingTfm = cfg.get<string>('designerTargetFramework', '').trim();
  let targetFramework: string;
  if (settingTfm) {
    targetFramework = settingTfm;
    channel.appendLine(`  TargetFramework : ${targetFramework} (from setting)`);
  } else {
    channel.appendLine('  TargetFramework : detecting highest installed .NET SDK…');
    targetFramework = await detectHighestDotnetSdkTfm(dotnet) ?? 'net10.0-windows';
    channel.appendLine(`  TargetFramework : ${targetFramework} (auto-detected)`);
  }

  channel.appendLine(`\n=== Building XamlDesigner ===`);
  channel.appendLine(`  Output          : ${outDir}`);
  channel.appendLine(`  TargetFramework : ${targetFramework}\n`);

  // Write a temporary Directory.Build.props so every project in the submodule
  // inherits the same TargetFramework during restore AND build — no csproj edits needed.
  const propsContent =
    `<!-- Auto-generated by vscode-wpf extension — do not commit -->\n` +
    `<Project>\n  <PropertyGroup>\n` +
    `    <TargetFramework>${targetFramework}</TargetFramework>\n` +
    `  </PropertyGroup>\n</Project>\n`;

  try {
    fs.writeFileSync(tempProps, propsContent, 'utf8');
    channel.appendLine(`  Wrote temporary Directory.Build.props\n`);
  } catch (err) {
    channel.appendLine(`WARNING: Could not write Directory.Build.props: ${err}`);
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Building WPF Designer Tools…', cancellable: false },
    async () => {
      await new Promise<void>(resolve => {
        void stopConflictingDesignerProcesses(dotnet, channel).then(() => {
          const restoreProc = cp.spawn(
            dotnet,
            ['restore', submoduleCsproj, '--nologo', '-p:UseSharedCompilation=false'],
            { shell: true }
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
                '--nologo', '--no-restore', '-maxcpucount:1', '-p:UseSharedCompilation=false'],
              { shell: true }
            );

            proc.stdout?.on('data', (d: Buffer) => channel.append(d.toString()));
            proc.stderr?.on('data', (d: Buffer) => channel.append(d.toString()));

            proc.on('close', (code: number | null) => {
              // Always remove the temp props file before reporting.
              try { fs.unlinkSync(tempProps); } catch { /* ignore */ }
              channel.appendLine('  Removed temporary Directory.Build.props');

              if (code === 0) {
                const builtOutputDir = path.join(
                  context.extensionPath,
                  'external',
                  'WpfDesigner',
                  'XamlDesigner',
                  'bin',
                  'Release',
                  targetFramework
                );

                try {
                  syncBuiltDesignerOutput(builtOutputDir, outDir);
                } catch (err) {
                  channel.appendLine(`ERROR: Failed to stage built designer artifacts: ${err}`);
                  vscode.window.showErrorMessage('Designer build succeeded, but staging the output failed. See "WPF Designer" output channel.');
                  resolve();
                  return;
                }

                writeDesignerTfm(outDir, targetFramework);
                channel.appendLine(`\nDesigner tools built successfully (${targetFramework}).`);
                vscode.window.showInformationMessage(`WPF Designer Tools built (${targetFramework}).`);
              } else {
                channel.appendLine(`\nBuild FAILED (exit code ${code}).`);
                vscode.window.showErrorMessage('Failed to build WPF Designer Tools. See "WPF Designer" output channel.');
              }
              resolve();
            });

            proc.on('error', (err: Error) => {
              try { fs.unlinkSync(tempProps); } catch { /* ignore */ }
              channel.appendLine(`ERROR: ${err.message}`);
              vscode.window.showErrorMessage(`Build error: ${err.message}`);
              resolve();
            });
          });
        });
      });
    }
  );
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
 * Use vswhere.exe to locate MSBuild.exe from the latest Visual Studio
 * installation. Required for legacy .NET Framework WPF projects that need
 * the full VS MSBuild toolchain (PresentationBuildTasks / WinFX targets).
 * Returns null if vswhere is not found or no VS installation is detected.
 */
async function findMsBuildExe(): Promise<string | null> {
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (!fs.existsSync(vswhere)) {
    return null;
  }

  return new Promise(resolve => {
    const proc = cp.spawn(
      vswhere,
      ['-latest', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'],
      { shell: false }
    );

    let output = '';
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', () => {
      const msbuild = output.trim().split('\n')[0]?.trim();
      resolve(msbuild && fs.existsSync(msbuild) ? msbuild : null);
    });
    proc.on('error', () => resolve(null));
  });
}

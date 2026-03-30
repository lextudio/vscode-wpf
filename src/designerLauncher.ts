import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface BuildResult {
  success: boolean;
  output: string;
}

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('WPF Designer');
  }
  return outputChannel;
}

// Track launched designer processes keyed by XAML file path so we don't
// spawn duplicates for the same file.
const activeDesigners = new Map<string, cp.ChildProcess>();

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

  // Detect whether this is an SDK-style project.
  const isSdkStyle = isSdkStyleProject(projectPath);
  const [cmd, args] = isSdkStyle
    ? [dotnet, ['build', projectPath, '--configuration', configuration, '--nologo', '-v', 'm']]
    : ['msbuild', [projectPath, `/p:Configuration=${configuration}`, '/nologo', '/v:m']];

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

    proc.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      output += s;
      channel.append(s);
    });

    proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      output += s;
      channel.append(s);
    });

    proc.on('close', (code: number | null) => {
      const success = code === 0;
      channel.appendLine(success ? '\nBuild succeeded.' : `\nBuild FAILED (exit code ${code}).`);
      resolve({ success, output });
    });

    proc.on('error', (err: Error) => {
      const msg = `Failed to start build process: ${err.message}`;
      channel.appendLine(msg);
      resolve({ success: false, output: msg });
    });
  });
}

/**
 * Resolve the path to XamlDesigner.exe.
 * Priority:
 *   1. `wpf.designerExecutable` user setting.
 *   2. `<extensionPath>/tools/XamlDesigner/XamlDesigner.exe` (bundled).
 */
export function getDesignerExecutable(context: vscode.ExtensionContext): string | null {
  const override = vscode.workspace
    .getConfiguration('wpf')
    .get<string>('designerExecutable', '');

  if (override && fs.existsSync(override)) {
    return override;
  }

  const toolsDir = path.join(context.extensionPath, 'tools', 'XamlDesigner');
  // Prefer explicit XamlDesigner.exe
  const candidateExe = path.join(toolsDir, 'XamlDesigner.exe');
  if (fs.existsSync(candidateExe)) {
    return candidateExe;
  }

  // Some builds produce Demo.XamlDesigner.exe or only DLLs. Check common names.
  const demoExe = path.join(toolsDir, 'Demo.XamlDesigner.exe');
  if (fs.existsSync(demoExe)) {
    return demoExe;
  }

  // If an EXE exists in the tools folder, use the first one found.
  try {
    const files = fs.readdirSync(toolsDir || '.');
    for (const f of files) {
      if (/\.exe$/i.test(f)) {
        return path.join(toolsDir, f);
      }
    }

    // If no EXE, check for DLLs (e.g., Demo.XamlDesigner.dll) and return the DLL path.
    for (const f of files) {
      if (/\.dll$/i.test(f)) {
        return path.join(toolsDir, f);
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Launch XamlDesigner.exe with the given XAML file and project assemblies.
 * Subsequent calls for the same XAML file focus the existing window instead of
 * spawning a duplicate process.
 */
export function launchDesigner(
  xamlPath: string,
  assemblies: string[],
  context: vscode.ExtensionContext
): void {
  const existing = activeDesigners.get(xamlPath);
  if (existing && !existing.killed) {
    // Process is still alive — don't spawn a second one.
    vscode.window.showInformationMessage(
      `Designer already open for ${path.basename(xamlPath)}.`
    );
    return;
  }

  const exe = getDesignerExecutable(context);
  if (!exe) {
    vscode.window
      .showErrorMessage(
        'XamlDesigner.exe not found. Run "WPF: Build Designer Tools" to build it.',
        'Build Designer Tools'
      )
      .then(action => {
        if (action === 'Build Designer Tools') {
          vscode.commands.executeCommand('wpf.buildDesignerTools');
        }
      });
    return;
  }

  const args = [xamlPath, ...assemblies];
  getOutputChannel().appendLine(`\n=== Launching Designer ===`);
  getOutputChannel().appendLine(`  Exe  : ${exe}`);
  getOutputChannel().appendLine(`  Args : ${args.join('\n         ')}\n`);

  // If the resolved path is a DLL, launch via `dotnet <dll>`; otherwise execute directly.
  let proc: cp.ChildProcess;
  if (/\.dll$/i.test(exe)) {
    const dotnet = vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet');
    proc = cp.spawn(dotnet, [exe, ...args], { shell: true, detached: true, stdio: 'ignore', windowsHide: false });
  } else {
    proc = cp.spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  }

  proc.unref(); // Allow VS Code to exit independently of the designer process.

  proc.on('error', (err: Error) => {
    vscode.window.showErrorMessage(`Failed to launch designer: ${err.message}`);
    activeDesigners.delete(xamlPath);
  });

  proc.on('close', (code: number | null) => {
    activeDesigners.delete(xamlPath);
    if (code !== 0 && code !== null) {
      getOutputChannel().appendLine(`Designer exited with code ${code} for ${path.basename(xamlPath)}.`);
    }
  });

  activeDesigners.set(xamlPath, proc);
}

/**
 * Build the XamlDesigner tool from the WpfDesigner submodule source.
 */
export async function buildDesignerTools(context: vscode.ExtensionContext): Promise<void> {
  const channel = getOutputChannel();
  channel.show(true);

  const submoduleCsproj = path.join(
    context.extensionPath,
    'external',
    'WpfDesigner',
    'XamlDesigner',
    'Demo.XamlDesigner.csproj'
  );

  if (!fs.existsSync(submoduleCsproj)) {
    channel.appendLine('ERROR: WpfDesigner submodule not found.');
    channel.appendLine('  Run: git submodule update --init --recursive');
    vscode.window.showErrorMessage(
      'WpfDesigner submodule not initialised. Run: git submodule update --init --recursive'
    );
    return;
  }

  const outDir = path.join(context.extensionPath, 'tools', 'XamlDesigner');
  const dotnet = vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet');

  channel.appendLine(`\n=== Building XamlDesigner ===`);
  channel.appendLine(`  Output: ${outDir}\n`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Building WPF Designer Tools…', cancellable: false },
    async () => {
      await new Promise<void>(resolve => {
        const proc = cp.spawn(
          dotnet,
          ['build', submoduleCsproj, '--configuration', 'Release', '--output', outDir, '--nologo'],
          { shell: true }
        );

        proc.stdout?.on('data', (d: Buffer) => channel.append(d.toString()));
        proc.stderr?.on('data', (d: Buffer) => channel.append(d.toString()));

        proc.on('close', (code: number | null) => {
          if (code === 0) {
            channel.appendLine('\nDesigner tools built successfully.');
            vscode.window.showInformationMessage('WPF Designer Tools built successfully.');
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
    }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristically determine if a .csproj is SDK-style (supports `dotnet build`).
 * SDK-style projects start with `<Project Sdk=`.
 */
function isSdkStyleProject(projectPath: string): boolean {
  try {
    const head = fs.readFileSync(projectPath, 'utf8').slice(0, 512);
    return /\<Project\s+Sdk\s*=/i.test(head);
  } catch {
    return true; // Assume SDK-style by default (more common today).
  }
}

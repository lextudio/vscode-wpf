import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Public API exposed by the lextudio.sharpdbg extension via its activate() return value.
 * Access it with getSharpDbgApi().
 */
export interface SharpDbgApi {
  /** Locates MSBuild.exe via vswhere. Returns undefined on non-Windows or when VS is not installed. */
  findMsBuildExe(): Promise<string | undefined>;
  /**
   * Resolves a .NET project to a launchable program, detecting project kind, selecting the build
   * tool, querying TargetPath via MSBuild, and building the project if the output binary is missing.
   */
  resolveProgramFromProjectPath(
    folder: vscode.WorkspaceFolder | undefined,
    projectPath: string,
    logger?: vscode.OutputChannel
  ): Promise<{ program: string; args: string[]; cwd: string; runtimeFlavor: string }>;
}

/** Returns the SharpDbg public API, or undefined if the extension is not active. */
export function getSharpDbgApi(): SharpDbgApi | undefined {
  return vscode.extensions.getExtension<SharpDbgApi>('lextudio.sharpdbg')?.exports;
}

export interface SharpDbgAdapter {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export function resolveSharpDbgAdapter(isFramework?: boolean, sessionConfig?: any): SharpDbgAdapter | null {
  const sharpDbgExt = vscode.extensions.getExtension('lextudio.sharpdbg');
  if (!sharpDbgExt) {
    return null;
  }

  const cfg = vscode.workspace.getConfiguration('sharpdbg');
  const adapterExecutableSetting = cfg.get<string>('adapterExecutable');
  const adapterArgsSetting = cfg.get<string[]>('adapterArgs') ?? [];
  const cliDllSetting = cfg.get<string>('cliDllPath') ?? 'dist/sharpdbg/net10.0/SharpDbg.Cli.dll';
  const dotnetPath = cfg.get<string>('dotnetPath') ?? 'dotnet';
  const adapterCwdSetting = cfg.get<string>('adapterCwd');
  const adapterEnvSetting = cfg.get<Record<string, string>>('adapterEnv');

  // 1) If user configured a custom adapter executable, prefer that.
  if (adapterExecutableSetting) {
    const resolved = path.isAbsolute(adapterExecutableSetting)
      ? adapterExecutableSetting
      : path.join(sharpDbgExt.extensionPath, adapterExecutableSetting);
    if (fs.existsSync(resolved)) {
      return { command: resolved, args: adapterArgsSetting, cwd: adapterCwdSetting ?? undefined, env: adapterEnvSetting ?? undefined };
    }

    // If it's not an absolute path and the file wasn't found inside the extension,
    // assume it's a command on PATH (best-effort).
    return { command: adapterExecutableSetting, args: adapterArgsSetting, cwd: adapterCwdSetting ?? undefined, env: adapterEnvSetting ?? undefined };
  }

  // 2) Inspect shipped dist layout inside the SharpDbg extension.
  const distDir = path.join(sharpDbgExt.extensionPath, 'dist', 'sharpdbg');
  if (fs.existsSync(distDir) && fs.statSync(distDir).isDirectory()) {
    try {
      const entries = fs.readdirSync(distDir);

      // If target is .NET Framework, prefer net4* runtime directories containing a native .exe.
      if (isFramework) {
        const net4dirs = entries.filter(e => /^net4/i.test(e));
        for (const d of net4dirs) {
          const exePath = path.join(distDir, d, 'SharpDbg.Cli.exe');
          if (fs.existsSync(exePath)) {
            return { command: exePath, args: ['--interpreter=vscode', ...adapterArgsSetting], cwd: adapterCwdSetting ?? undefined, env: adapterEnvSetting ?? undefined };
          }
        }
      }

      // 3) Prefer configured CLI DLL when present (dotnet host).
      const dllResolved = path.isAbsolute(cliDllSetting) ? cliDllSetting : path.join(sharpDbgExt.extensionPath, cliDllSetting);
      if (fs.existsSync(dllResolved)) {
        return { command: dotnetPath, args: [dllResolved, '--interpreter=vscode', ...adapterArgsSetting], cwd: adapterCwdSetting ?? undefined, env: adapterEnvSetting ?? undefined };
      }

      // 4) Fall back to scanning other shipped runtimes (choose a non-net4 if possible).
      const netDirs = entries.filter(e => /^net/i.test(e)).sort().reverse();
      for (const d of netDirs) {
        if (isFramework && /^net4/i.test(d)) {
          continue; // already tried
        }
        const dllCandidate = path.join(distDir, d, 'SharpDbg.Cli.dll');
        if (fs.existsSync(dllCandidate)) {
          return { command: dotnetPath, args: [dllCandidate, '--interpreter=vscode', ...adapterArgsSetting], cwd: adapterCwdSetting ?? undefined, env: adapterEnvSetting ?? undefined };
        }
        const exeCandidate = path.join(distDir, d, 'SharpDbg.Cli.exe');
        if (fs.existsSync(exeCandidate)) {
          return { command: exeCandidate, args: ['--interpreter=vscode', ...adapterArgsSetting], cwd: adapterCwdSetting ?? undefined, env: adapterEnvSetting ?? undefined };
        }
      }
    } catch (e) {
      // ignore and continue to other fallbacks
    }
  }

  // 5) Legacy layout: tools/SharpDbg/SharpDbg.Cli.exe inside the host extension (older packaging).
  const legacyExe = path.join(sharpDbgExt.extensionPath, 'tools', 'SharpDbg', 'SharpDbg.Cli.exe');
  if (fs.existsSync(legacyExe)) {
    return { command: legacyExe, args: ['--interpreter=vscode', ...adapterArgsSetting], cwd: adapterCwdSetting ?? undefined, env: adapterEnvSetting ?? undefined };
  }

  return null;
}

export async function promptInstallSharpDbg(context?: vscode.ExtensionContext): Promise<void> {
  try {
    const suppressed = context?.globalState?.get<boolean>('sharpdbg.prompt.suppress', false) ?? false;
    if (suppressed) {
      return;
    }

    const install = 'Install';
    const open = 'Open Marketplace';
    const dont = "Don't Show Again";

    const choice = await vscode.window.showInformationMessage(
      'The SharpDbg extension (lextudio.sharpdbg) is required for WPF debugging. Install it from the Marketplace?',
      install,
      open,
      dont
    );

    if (choice === install) {
      try {
        // Attempt programmatic install via VS Code command.
        // Falls back to opening the marketplace page if the command fails.
        // @ts-ignore executeCommand is expected to exist in VS Code environment.
        await vscode.commands.executeCommand('workbench.extensions.installExtension', 'lextudio.sharpdbg');
        const reload = 'Reload Window';
        const r = await vscode.window.showInformationMessage('SharpDbg installed. Reload the window to activate it.', reload, 'Later');
        if (r === reload) {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (e) {
        await vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=lextudio.sharpdbg'));
      }
    } else if (choice === open) {
      await vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=lextudio.sharpdbg'));
    } else if (choice === dont && context) {
      await context.globalState.update('sharpdbg.prompt.suppress', true);
    }
  } catch (e) {
    // Don't surface prompt failures to the user flow.
    console.error('Failed to show SharpDbg install prompt:', e);
  }
}

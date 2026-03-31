import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ProjectInfo {
  projectPath: string;
  projectName: string;
  targetFramework: string;
  outputPath: string;
}

export interface LaunchTargetInfo {
  program: string;
  args: string[];
  cwd: string;
}

export function isCSharpDevKitInstalled(): boolean {
  return vscode.extensions.getExtension('ms-dotnettools.csdevkit') !== undefined;
}

/**
 * Returns true if the XAML file appears to be a WPF XAML file.
 * Checks the root element's namespace declarations for known non-WPF indicators.
 */
export function isWpfXaml(xamlPath: string): boolean {
  try {
    const fd = fs.openSync(xamlPath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);

    // Avalonia uses its own distinct root namespace
    if (/xmlns\s*=\s*["']https?:\/\/github\.com\/avaloniaui["']/i.test(head) ||
        /xmlns\s*=\s*["']https?:\/\/avaloniaui\.net\//i.test(head)) {
      return false;
    }

    // UWP / WinUI / Uno use "using:" namespace syntax — WPF never does
    if (/xmlns:\w+\s*=\s*["']using:/i.test(head)) {
      return false;
    }

    // WPF's canonical presentation namespace must be the default xmlns
    return /xmlns\s*=\s*["']http:\/\/schemas\.microsoft\.com\/winfx\/2006\/xaml\/presentation["']/i.test(head);
  } catch {
    return false;
  }
}

/**
 * Returns true if the .csproj is a WPF project.
 * SDK-style projects must have <UseWPF>true</UseWPF>.
 * Legacy projects are recognised by WPF type GUIDs or PresentationFramework references.
 * Projects referencing Avalonia, Uno, or WinAppSDK are rejected.
 */
export function isWpfProject(projectPath: string): boolean {
  try {
    const xml = fs.readFileSync(projectPath, 'utf8');

    // Hard rejections — non-WPF frameworks
    if (/PackageReference[^>]+Include\s*=\s*["']Avalonia["']/i.test(xml)) { return false; }
    if (/PackageReference[^>]+Include\s*=\s*["']Uno\.(WinUI|UI)["']/i.test(xml)) { return false; }
    if (/PackageReference[^>]+Include\s*=\s*["']Microsoft\.WindowsAppSDK["']/i.test(xml)) { return false; }
    if (/<TargetPlatformIdentifier[^>]*>\s*UAP\s*<\/TargetPlatformIdentifier>/i.test(xml)) { return false; }

    const isSdk = /\<Project\s+Sdk\s*=/i.test(xml.slice(0, 512));
    if (isSdk) {
      // SDK-style WPF projects explicitly opt in with <UseWPF>true</UseWPF>
      return /<UseWPF\s*>\s*true\s*<\/UseWPF>/i.test(xml);
    }

    // Legacy (non-SDK) projects: WPF type GUID or direct PresentationFramework reference
    return /\{60DC8134-EBA5-43B8-BCC9-BB4BC16C2548\}/i.test(xml) ||
           /Include\s*=\s*["']PresentationFramework["']/i.test(xml);
  } catch {
    return false;
  }
}

/**
 * Walk up from the directory containing the XAML file to the workspace root
 * looking for a WPF .csproj file. Returns the first one found, or null.
 */
export async function findProjectForFile(xamlFilePath: string): Promise<string | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const roots = workspaceFolders ? workspaceFolders.map(f => f.uri.fsPath) : [];

  let dir = path.dirname(xamlFilePath);

  while (true) {
    try {
      const entries = fs.readdirSync(dir);
      const csproj = entries.find((e: string) => e.endsWith('.csproj'));
      if (csproj) {
        const projectPath = path.join(dir, csproj);
        if (isWpfProject(projectPath)) {
          return projectPath;
        }
      }
    } catch {
      break;
    }

    const parent = path.dirname(dir);
    if (parent === dir || roots.some(r => dir === r)) {
      break;
    }
    dir = parent;
  }

  return null;
}

/**
 * Find all WPF .csproj files across workspace folders (up to 50).
 */
export async function findProjectsInWorkspace(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles('**/*.csproj', '**/node_modules/**', 50);
  return uris.map(u => u.fsPath).filter(isWpfProject);
}

/**
 * Find all .sln files across workspace folders (up to 20).
 */
export async function findSolutionsInWorkspace(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles('**/*.sln', '**/node_modules/**', 20);
  return uris.map(u => u.fsPath);
}

/**
 * Parse a .csproj to derive TargetFramework and the expected output directory.
 */
export function parseProject(projectPath: string): { projectName: string; targetFramework: string; outputPath: string } {
  const projectDir = path.dirname(projectPath);
  const projectName = path.basename(projectPath, '.csproj');

  let targetFramework = 'net10.0-windows';
  let outputPathOverride: string | null = null;

  try {
    const xml = fs.readFileSync(projectPath, 'utf8');

    const tfm = xmlValue(xml, 'TargetFramework');
    const tfms = xmlValue(xml, 'TargetFrameworks');
    const tfmVersion = xmlValue(xml, 'TargetFrameworkVersion');
    if (tfm) {
      targetFramework = tfm;
    } else if (tfms) {
      targetFramework = tfms.split(';')[0].trim();
    } else if (tfmVersion) {
      // Legacy .NET Framework projects use <TargetFrameworkVersion>v4.6.2</TargetFrameworkVersion>.
      // Convert to a short TFM moniker like "net462".
      targetFramework = 'net' + tfmVersion.replace(/^v/i, '').replace(/\./g, '');
    }

    const op = xmlValue(xml, 'OutputPath');
    if (op) {
      outputPathOverride = path.resolve(projectDir, op.replace(/[\\/]/g, path.sep));
    }
  } catch {
    // Fall back to defaults
  }

  const config = vscode.workspace
    .getConfiguration('wpf')
    .get<string>('buildConfiguration', 'Debug');

  const outputPath = outputPathOverride ?? path.join(projectDir, 'bin', config, targetFramework);

  return { projectName, targetFramework, outputPath };
}

/**
 * Return .dll paths in the project output directory (requires a prior build).
 */
export function getOutputAssemblies(projectPath: string): string[] {
  const { outputPath } = parseProject(projectPath);

  if (!fs.existsSync(outputPath)) {
    return [];
  }

  return fs
    .readdirSync(outputPath)
    .filter((f: string) => f.endsWith('.dll') && !f.endsWith('.resources.dll'))
    .map((f: string) => path.join(outputPath, f));
}

/**
 * Best-effort incremental check used before spawning a preview build.
 * If the newest relevant source file is older than the newest output assembly,
 * we can skip `dotnet build` and launch the designer immediately.
 */
export function areProjectOutputsUpToDate(projectPath: string): boolean {
  const { outputPath } = parseProject(projectPath);
  if (!fs.existsSync(outputPath)) {
    return false;
  }

  const outputFiles = fs
    .readdirSync(outputPath)
    .filter((f: string) =>
      (f.endsWith('.dll') && !f.endsWith('.resources.dll')) ||
      f.endsWith('.exe'))
    .map((f: string) => path.join(outputPath, f))
    .filter((f: string) => fs.existsSync(f));

  if (outputFiles.length === 0) {
    return false;
  }

  let newestOutputTime = 0;
  for (const file of outputFiles) {
    newestOutputTime = Math.max(newestOutputTime, fs.statSync(file).mtimeMs);
  }

  let newestInputTime = 0;
  const projectDir = path.dirname(projectPath);
  const pending: string[] = [projectDir];
  const ignoredDirs = new Set(['bin', 'obj', '.git', 'node_modules', '.vs']);
  const watchedExtensions = new Set(['.cs', '.xaml', '.csproj', '.props', '.targets', '.resx']);

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (!watchedExtensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      newestInputTime = Math.max(newestInputTime, fs.statSync(fullPath).mtimeMs);
      if (newestInputTime > newestOutputTime) {
        return false;
      }
    }
  }

  return newestInputTime > 0 && newestInputTime <= newestOutputTime;
}

/**
 * Resolve the best launch target for a WPF project output.
 * For modern SDK-style WPF projects this is usually the generated `.exe`.
 * If only a `.dll` exists, launch through `dotnet`.
 */
export function getLaunchTarget(projectPath: string, dotnetPath = 'dotnet'): LaunchTargetInfo | null {
  const { projectName, outputPath } = parseProject(projectPath);
  if (!fs.existsSync(outputPath)) {
    return null;
  }

  const exePath = path.join(outputPath, `${projectName}.exe`);
  if (fs.existsSync(exePath)) {
    return {
      program: exePath,
      args: [],
      cwd: path.dirname(projectPath),
    };
  }

  const dllPath = path.join(outputPath, `${projectName}.dll`);
  if (fs.existsSync(dllPath)) {
    return {
      program: dotnetPath,
      args: [dllPath],
      cwd: path.dirname(projectPath),
    };
  }

  const fallbackExe = fs.readdirSync(outputPath)
    .filter(f => f.toLowerCase().endsWith('.exe'))
    .map(f => path.join(outputPath, f))[0];
  if (fallbackExe) {
    return {
      program: fallbackExe,
      args: [],
      cwd: path.dirname(projectPath),
    };
  }

  const fallbackDll = fs.readdirSync(outputPath)
    .filter(f => f.toLowerCase().endsWith('.dll') && !f.toLowerCase().endsWith('.resources.dll'))
    .map(f => path.join(outputPath, f))[0];
  if (fallbackDll) {
    return {
      program: dotnetPath,
      args: [fallbackDll],
      cwd: path.dirname(projectPath),
    };
  }

  return null;
}

/**
 * Show a QuickPick so the user can choose which project to build/preview.
 */
export async function showProjectPicker(projects: string[]): Promise<string | undefined> {
  if (projects.length === 0) {
    vscode.window.showWarningMessage(
      'No .csproj files found in the workspace. Open a folder containing a WPF project.'
    );
    return undefined;
  }

  if (projects.length === 1) {
    return projects[0];
  }

  const items = projects.map(p => ({
    label: path.basename(p),
    description: vscode.workspace.asRelativePath(p),
    projectPath: p,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the WPF project to build and preview',
  });

  return pick?.projectPath;
}

// ---------------------------------------------------------------------------
// Minimal XML value extractor (no external dependencies)
// ---------------------------------------------------------------------------

function xmlValue(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

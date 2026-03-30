import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ProjectInfo {
  projectPath: string;
  projectName: string;
  targetFramework: string;
  outputPath: string;
}

export function isCSharpDevKitInstalled(): boolean {
  return vscode.extensions.getExtension('ms-dotnettools.csdevkit') !== undefined;
}

/**
 * Walk up from the directory containing the XAML file to the workspace root
 * looking for a .csproj file. Returns the first one found, or null.
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
        return path.join(dir, csproj);
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
 * Find all .csproj files across workspace folders (up to 50).
 */
export async function findProjectsInWorkspace(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles('**/*.csproj', '**/node_modules/**', 50);
  return uris.map(u => u.fsPath);
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

  let targetFramework = 'net6.0-windows';
  let outputPathOverride: string | null = null;

  try {
    const xml = fs.readFileSync(projectPath, 'utf8');

    const tfm = xmlValue(xml, 'TargetFramework');
    const tfms = xmlValue(xml, 'TargetFrameworks');
    if (tfm) {
      targetFramework = tfm;
    } else if (tfms) {
      targetFramework = tfms.split(';')[0].trim();
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

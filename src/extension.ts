import * as vscode from 'vscode';
import * as path from 'path';
import {
  areProjectOutputsUpToDate,
  findProjectForFile,
  findProjectsInWorkspace,
  getOutputAssemblies,
  isCSharpDevKitInstalled,
  isWpfProject,
  isWpfXaml,
  showProjectPicker,
} from './projectDiscovery';
import {
  buildProject,
  buildDesignerTools,
  checkDesignerCompatibility,
  getDesignerExecutable,
  launchDesigner,
} from './designerLauncher';
import { disposeStatusBar, getStatusBarItem, updateStatusBar } from './statusBar';
import { startLanguageServer, stopLanguageServer } from './languageServer';

// Per-workspace-folder project selection, keyed by workspace folder path.
const selectedProjects = new Map<string, string>();
const previewOperations = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  console.log('VS Code WPF extension is now active.');

  // Start the WPF XAML language server (no-op if binary not yet built).
  startLanguageServer(context);

  // -------------------------------------------------------------------------
  // Command: wpf.previewXaml
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.previewXaml', async (uri?: vscode.Uri) => {
      const resource = uri ?? vscode.window.activeTextEditor?.document?.uri;
      if (!resource) {
        vscode.window.showWarningMessage('No XAML file is currently open.');
        return;
      }

      const xamlPath = resource.fsPath;

      // 0. Verify this is a WPF XAML file, not UWP/WinUI/Uno/Avalonia.
      if (!isWpfXaml(xamlPath)) {
        vscode.window.showErrorMessage(
          'This XAML file does not appear to be a WPF file. ' +
          'The WPF extension only supports WPF XAML (xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation").'
        );
        return;
      }

      // 1. Resolve project
      const projectPath = await resolveProject(xamlPath);
      if (!projectPath) {
        return; // User cancelled picker or no project found.
      }

      // 1b. Verify the resolved project is a WPF project.
      if (!isWpfProject(projectPath)) {
        vscode.window.showErrorMessage(
          `"${path.basename(projectPath)}" is not a WPF project. ` +
          'Only projects with <UseWPF>true</UseWPF> (or legacy WPF project references) are supported.'
        );
        return;
      }

      if (previewOperations.has(projectPath)) {
        vscode.window.showInformationMessage(
          `Preview is already in progress for ${path.basename(projectPath)}.`
        );
        return;
      }

      previewOperations.add(projectPath);

      try {

        // 2. Check designer binary exists before potentially long build.
        const exeExists = getDesignerExecutable(context) !== null;

        // 2b. Check TFM compatibility between the project and the built designer.
        const compat = checkDesignerCompatibility(projectPath, context);
        if (!compat.compatible) {
          if (compat.canRebuild) {
            const action = await vscode.window.showWarningMessage(
              compat.message,
              'Rebuild Designer',
              'Launch Anyway'
            );
            if (action === 'Rebuild Designer') {
              await buildDesignerTools(context);
            } else if (action !== 'Launch Anyway') {
              return; // Dismissed
            }
          } else {
            // .NET Framework project — can still open without custom type support.
            const action = await vscode.window.showWarningMessage(
              compat.message,
              'Continue',
              'Cancel'
            );
            if (action !== 'Continue') {
              return;
            }
          }
        }

        // 3. Optionally build the project.
        const cfg = vscode.workspace.getConfiguration('wpf');
        const autoBuild = cfg.get<boolean>('autoBuildOnPreview', true);
        const outputsUpToDate = areProjectOutputsUpToDate(projectPath);

        if (autoBuild && !outputsUpToDate) {
          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Building ${path.basename(projectPath)}…`,
              cancellable: true,
            },
            (_progress, token) => buildProject(projectPath, token)
          );

          if (!result.success) {
            vscode.window
              .showErrorMessage(
                `Build failed for ${path.basename(projectPath)}.`,
                'Show Output'
              )
              .then(action => {
                if (action === 'Show Output') {
                  vscode.commands.executeCommand('workbench.action.output.toggleOutput');
                }
              });
            return;
          }
        }

        // 4. Collect assemblies from build output.
        const assemblies = getOutputAssemblies(projectPath);

        // 5. If designer not found, offer to build it now.
        if (!exeExists) {
          const action = await vscode.window.showErrorMessage(
            'XamlDesigner.exe not found.',
            'Build Designer Tools',
            'Cancel'
          );
          if (action === 'Build Designer Tools') {
            await buildDesignerTools(context);
          }
          return;
        }

        // 6. Launch the designer (or send the file to the running instance).
        launchDesigner(xamlPath, assemblies, context, projectPath);
      } finally {
        previewOperations.delete(projectPath);
      }
    })
  );

  // -------------------------------------------------------------------------
  // Command: wpf.selectProject
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.selectProject', async () => {
      const projects = await findProjectsInWorkspace();
      const picked = await showProjectPicker(projects);
      if (picked) {
        const folderKey = getWorkspaceFolderKey(picked);
        selectedProjects.set(folderKey, picked);
        updateStatusBar(vscode.window.activeTextEditor, picked);
        vscode.window.showInformationMessage(
          `WPF project set to: ${path.basename(picked)}`
        );
      }
    })
  );

  // -------------------------------------------------------------------------
  // Command: wpf.buildDesignerTools
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.buildDesignerTools', () =>
      buildDesignerTools(context)
    )
  );

  // -------------------------------------------------------------------------
  // Status bar — update whenever the active editor changes.
  // -------------------------------------------------------------------------
  context.subscriptions.push(getStatusBarItem());

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      const project = editor ? getCachedProject(editor.document.uri.fsPath) : null;
      updateStatusBar(editor, project ?? null);
    })
  );

  // Initialise for the current editor (if any).
  {
    const editor = vscode.window.activeTextEditor;
    const project = editor ? getCachedProject(editor.document.uri.fsPath) : null;
    updateStatusBar(editor, project ?? null);
  }

  // -------------------------------------------------------------------------
  // Hover provider — XAML symbol info.
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: 'file', language: 'xaml' },
      {
        provideHover(document: vscode.TextDocument, position: vscode.Position) {
          const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9_.:-]+/);
          const word = range ? document.getText(range) : '';
          if (!word) {
            return undefined;
          }
          return new vscode.Hover(`XAML symbol: \`${word}\``);
        },
      }
    )
  );
}

export async function deactivate(): Promise<void> {
  await stopLanguageServer();
  disposeStatusBar();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the project to use for a given XAML file:
 *  1. Already cached for this workspace folder.
 *  2. Auto-detect by walking up the directory tree.
 *  3. Fall back to a quick-pick over all workspace projects.
 */
async function resolveProject(xamlPath: string): Promise<string | null> {
  const folderKey = getWorkspaceFolderKey(xamlPath);

  // 1. Cached selection.
  const cached = selectedProjects.get(folderKey);
  if (cached) {
    return cached;
  }

  // 2. Auto-detect.
  const detected = await findProjectForFile(xamlPath);
  if (detected) {
    // If C# Dev Kit is present, silently use the detected project without
    // prompting the user (it already shows its own solution picker).
    if (isCSharpDevKitInstalled()) {
      selectedProjects.set(folderKey, detected);
      updateStatusBar(vscode.window.activeTextEditor, detected);
      return detected;
    }

    // Confirm with the user (they may want a different project).
    const action = await vscode.window.showInformationMessage(
      `Use project "${path.basename(detected)}" for this XAML file?`,
      'Yes',
      'Pick another…'
    );

    if (action === 'Yes') {
      selectedProjects.set(folderKey, detected);
      updateStatusBar(vscode.window.activeTextEditor, detected);
      return detected;
    }

    // Fall through to picker if they chose "Pick another…"
  }

  // 3. Picker.
  const projects = await findProjectsInWorkspace();
  const picked = await showProjectPicker(projects);
  if (picked) {
    selectedProjects.set(folderKey, picked);
    updateStatusBar(vscode.window.activeTextEditor, picked);
  }
  return picked ?? null;
}

function getCachedProject(filePath: string): string | undefined {
  const key = getWorkspaceFolderKey(filePath);
  return selectedProjects.get(key);
}

/**
 * Derive a stable key from the workspace folder that contains `filePath`.
 * Falls back to the file's directory so the map still works outside a workspace.
 */
function getWorkspaceFolderKey(filePath: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  return folder?.uri.fsPath ?? path.dirname(filePath);
}

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
  hasRunningDesignerSession,
  launchDesigner,
  pushLiveXamlUpdate,
  restartDesignerSession,
} from './designerLauncher';
import { disposeStatusBar, getStatusBarItem, updateStatusBar } from './statusBar';
import { getPreviewProjectContext, startLanguageServer, stopLanguageServer } from './languageServer';
import {
  getRuntimeSessionInfo,
  hasRunningRuntimeSession,
  pushRuntimeXamlUpdate,
  registerRuntimeHotReload,
  showRuntimeHotReloadOutput,
  startRuntimeHotReloadSession,
} from './runtimeHotReload';

// Per-workspace-folder project selection, keyed by workspace folder path.
const selectedProjects = new Map<string, string>();
const previewOperations = new Set<string>();
const hotReloadTimers = new Map<string, NodeJS.Timeout>();

export function activate(context: vscode.ExtensionContext): void {
  console.log('VS Code WPF extension is now active.');

  // Start the WPF XAML language server (no-op if binary not yet built).
  startLanguageServer(context);
  registerRuntimeHotReload(context);

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
      const xamlDocument = await vscode.workspace.openTextDocument(resource);
      const xamlText = xamlDocument.getText();
      await startLanguageServer(context);

      // 0. Verify this is a WPF XAML file, not UWP/WinUI/Uno/Avalonia.
      if (!isWpfXaml(xamlPath)) {
        vscode.window.showErrorMessage(
          'This XAML file does not appear to be a WPF file. ' +
          'The WPF extension only supports WPF XAML (xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation").'
        );
        return;
      }

      // 1. Resolve project
      const previewContext = await getPreviewProjectContext(resource);
      const projectPath = previewContext?.projectPath ?? await resolveProject(xamlPath);
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
        const hasRunningSession = hasRunningDesignerSession(projectPath);
        const blockingDiagnostics = vscode.languages
          .getDiagnostics(resource)
          .filter(d =>
            d.severity === vscode.DiagnosticSeverity.Error &&
            (d.source === 'MSBuildWorkspace' || d.source === 'AXSG.Semantic'));

        if (blockingDiagnostics.length > 0 && outputsUpToDate) {
          vscode.window.showErrorMessage(
            'Preview is blocked because the language server reports XAML/project errors for the current file.'
          );
          return;
        }

        if (autoBuild && !outputsUpToDate && !hasRunningSession) {
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

        if (hasRunningSession && !outputsUpToDate) {
          vscode.window.showInformationMessage(
            'Designer is already running, so Preview sent a live XAML update without rebuilding. Use "WPF: Rebuild and Restart Designer" after code or project changes.'
          );
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
        launchDesigner(xamlPath, assemblies, context, projectPath, xamlText);
      } finally {
        previewOperations.delete(projectPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.rebuildRestartDesigner', async (uri?: vscode.Uri) => {
      const resource = uri ?? vscode.window.activeTextEditor?.document?.uri;
      if (!resource) {
        vscode.window.showWarningMessage('No XAML file is currently open.');
        return;
      }

      const xamlPath = resource.fsPath;
      const xamlDocument = await vscode.workspace.openTextDocument(resource);
      const xamlText = xamlDocument.getText();

      if (!isWpfXaml(xamlPath)) {
        vscode.window.showErrorMessage('The active file is not recognized as WPF XAML.');
        return;
      }

      const previewContext = await getPreviewProjectContext(resource);
      const projectPath = previewContext?.projectPath ?? await resolveProject(xamlPath);
      if (!projectPath) {
        return;
      }

      if (!isWpfProject(projectPath)) {
        vscode.window.showErrorMessage(
          `"${path.basename(projectPath)}" is not a WPF project. ` +
          'Only projects with <UseWPF>true</UseWPF> (or legacy WPF project references) are supported.'
        );
        return;
      }

      restartDesignerSession(projectPath);

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Rebuilding ${path.basename(projectPath)} for designer…`,
          cancellable: true,
        },
        (_progress, token) => buildProject(projectPath, token)
      );

      if (!result.success) {
        vscode.window.showErrorMessage(
          `Rebuild failed for ${path.basename(projectPath)}.`
        );
        return;
      }

      const assemblies = getOutputAssemblies(projectPath);
      if (getDesignerExecutable(context) === null) {
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

      launchDesigner(xamlPath, assemblies, context, projectPath, xamlText);
    })
  );

  // -------------------------------------------------------------------------
  // Command: wpf.selectProject
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.hotReload', async (uri?: vscode.Uri) => {
      const resource = uri ?? vscode.window.activeTextEditor?.document?.uri;
      if (!resource) {
        vscode.window.showWarningMessage('No XAML file is currently open.');
        return;
      }

      const xamlPath = resource.fsPath;
      if (!isWpfXaml(xamlPath)) {
        vscode.window.showErrorMessage('The active file is not recognized as WPF XAML.');
        return;
      }

      await startLanguageServer(context);

      const previewContext = await getPreviewProjectContext(resource);
      const projectPath = previewContext?.projectPath ?? await resolveProject(xamlPath);
      if (!projectPath) {
        return;
      }

      if (!isWpfProject(projectPath)) {
        vscode.window.showErrorMessage(
          `"${path.basename(projectPath)}" is not a WPF project. ` +
          'Only projects with <UseWPF>true</UseWPF> (or legacy WPF project references) are supported.'
        );
        return;
      }

      if (hasRunningRuntimeSession(projectPath)) {
        showRuntimeHotReloadOutput();
        const xamlDocument = await vscode.workspace.openTextDocument(resource);
        const pushed = await pushRuntimeXamlUpdate(projectPath, xamlPath, xamlDocument.getText());
        if (pushed) {
          vscode.window.showInformationMessage(
            `Applied hot reload update for ${path.basename(xamlPath)}.`
          );
        } else {
          vscode.window.showWarningMessage(
            'WPF hot reload did not apply. See the "WPF Hot Reload" output channel for details.'
          );
        }
        return;
      }

      showRuntimeHotReloadOutput();
      const started = await startRuntimeHotReloadSession(context, projectPath, xamlPath);
      if (!started) {
        return;
      }

      vscode.window.showInformationMessage(
        `Started WPF hot reload session for ${path.basename(projectPath)}. Once the app finishes loading, click Hot Reload again to push the current XAML file.`
      );
    })
  );

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

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf._test.setProject', async (args?: { filePath?: string; projectPath?: string }) => {
      const projectPath = args?.projectPath;
      const filePath = args?.filePath;
      if (!projectPath || !filePath) {
        throw new Error('wpf._test.setProject requires filePath and projectPath.');
      }

      selectedProjects.set(getWorkspaceFolderKey(filePath), projectPath);
      updateStatusBar(vscode.window.activeTextEditor, projectPath);
      return true;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf._test.getRuntimeSessionInfo', async (projectPath?: string) => {
      if (!projectPath) {
        return null;
      }

      const info = getRuntimeSessionInfo(projectPath);
      if (!info) {
        return null;
      }

      return {
        projectPath: info.projectPath,
        xamlPath: info.xamlPath,
        pipeName: info.pipeName ?? null,
        pid: info.childProcess.pid ?? null,
      };
    })
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

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      void scheduleHotReload(event.document);
    })
  );

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
  for (const timer of hotReloadTimers.values()) {
    clearTimeout(timer);
  }
  hotReloadTimers.clear();
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

async function scheduleHotReload(document: vscode.TextDocument): Promise<void> {
  if (document.uri.scheme !== 'file' || document.languageId !== 'xaml') {
    return;
  }

  if (!isWpfXaml(document.uri.fsPath)) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('wpf');
  const livePreviewOnEdit = cfg.get<boolean>('livePreviewOnEdit', true);
  if (!livePreviewOnEdit) {
    return;
  }

  const key = document.uri.toString();
  const existing = hotReloadTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  hotReloadTimers.set(key, setTimeout(() => {
    hotReloadTimers.delete(key);
    void pushHotReload(document);
  }, 300));
}

async function pushHotReload(document: vscode.TextDocument): Promise<void> {
  const resource = document.uri;
  const xamlPath = resource.fsPath;
  const previewContext = await getPreviewProjectContext(resource);
  const projectPath = previewContext?.projectPath ?? getCachedProject(xamlPath) ?? await findProjectForFile(xamlPath);
  if (!projectPath) {
    return;
  }

  const blockingDiagnostics = vscode.languages
    .getDiagnostics(resource)
    .filter(d =>
      d.severity === vscode.DiagnosticSeverity.Error &&
      (d.source === 'MSBuildWorkspace' || d.source === 'AXSG.Semantic'));

  if (blockingDiagnostics.length > 0) {
    return;
  }

  if (!hasRunningDesignerSession(projectPath)) {
    return;
  }

  pushLiveXamlUpdate(projectPath, xamlPath, document.getText());
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  areProjectOutputsUpToDate,
  findProjectForFile,
  findProjectsInWorkspace,
  getOutputAssemblies,
  isCSharpDevKitInstalled,
  isWpfProject,
  isWpfXaml,
  parseProject,
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
import {
  getHotReloadMapDocument,
  getPreviewProjectContext,
  startLanguageServer,
  stopLanguageServer,
} from './languageServer';
import {
  captureRuntimePreview,
  findRuntimePreviewElement,
  getRuntimeSessionInfo,
  hasRunningRuntimeSession,
  hitTestRuntimePreview,
  inspectRuntimePreviewElement,
  pushRuntimeXamlUpdate,
  registerRuntimeHotReload,
  setRuntimePreviewHostVisibility,
  showRuntimeHotReloadOutput,
  startRuntimeHotReloadSession,
} from './runtimeHotReload';
import { registerToolbox } from './toolbox';
import { WpfLivePreviewPanel } from './livePreview';

// Per-workspace-folder project selection, keyed by workspace folder path.
const selectedProjects = new Map<string, string>();
const previewOperations = new Set<string>();
const hotReloadTimers = new Map<string, NodeJS.Timeout>();
const previewSelectionSyncTimers = new Map<string, NodeJS.Timeout>();
const axsgMapConfidenceThreshold = 0.7;
const livePreviewMappingHintDurationMs = 3500;
const livePreviewHintCooldownMs = 1800;
let lastLivePreviewHintAt = 0;
let lastLivePreviewHintText = '';
let lastLivePreviewXamlPath: string | undefined;

interface LivePreviewToolboxItem {
  readonly kind: 'wpfToolboxItem';
  readonly displayName: string;
  readonly typeName: string;
  readonly xmlNamespace?: string;
  readonly clrNamespace?: string;
  readonly assemblyName?: string;
  readonly prefixHint?: string;
  readonly requiresPrefix: boolean;
  readonly defaultSnippet: string;
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('VS Code WPF extension is now active.');

  // Start the WPF XAML language server (no-op if binary not yet built).
  startLanguageServer(context);
  registerRuntimeHotReload(context);
  const toolboxUi = registerToolbox(context);

  const resolveLivePreviewContext = async (): Promise<
    | { ok: true; projectPath: string; xamlPath: string }
    | { ok: false; message: string }
  > => {
    const resource = resolveLivePreviewResource();
    if (!resource) {
      return {
        ok: false,
        message: 'Open a WPF XAML file in the editor once to initialize Live Preview context.',
      };
    }

    const xamlPath = resource.fsPath;
    if (!isWpfXaml(xamlPath)) {
      return {
        ok: false,
        message: 'The active file is not recognized as WPF XAML.',
      };
    }

    const previewContext = await getPreviewProjectContext(resource);
    const projectPath = previewContext?.projectPath ?? await resolveProject(xamlPath);
    if (!projectPath) {
      return {
        ok: false,
        message: 'No project selected for the active XAML file.',
      };
    }

    if (!hasRunningRuntimeSession(projectPath)) {
      const autoStartRuntime = vscode.workspace.getConfiguration('wpf').get<boolean>('livePreviewAutoStartRuntime', true);
      if (!autoStartRuntime) {
        return {
          ok: false,
          message: 'No running runtime session. Run "WPF: Hot Reload" first to start the app.',
        };
      }

      const started = await startRuntimeHotReloadSession(context, projectPath, xamlPath, 'livePreview');
      if (!started) {
        return {
          ok: false,
          message: 'Failed to start runtime session for Live Preview. Check the "WPF Live Preview" output.',
        };
      }
    }

    const hideHost = vscode.workspace.getConfiguration('wpf').get<boolean>('livePreviewHideRunningApp', true);
    if (hideHost) {
      await setRuntimePreviewHostVisibility(projectPath, true);
    }

    lastLivePreviewXamlPath = xamlPath;

    return {
      ok: true,
      projectPath,
      xamlPath,
    };
  };

  const livePreviewPanel = new WpfLivePreviewPanel(
    async () => {
      const contextResult = await resolveLivePreviewContext();
      if (!contextResult.ok) {
        toolboxUi.clearPropertyGrid(contextResult.message);
        return {
          ok: false as const,
          message: contextResult.message,
        };
      }

      const frame = await captureRuntimePreview(contextResult.projectPath, contextResult.xamlPath);
      if (!frame) {
        return {
          ok: false as const,
          message: 'Runtime preview is not ready yet. Wait for the app to finish loading and refresh.',
        };
      }

      return {
        ok: true as const,
        snapshot: {
          imageDataUrl: `data:image/png;base64,${frame.pngBase64}`,
          width: frame.width,
          height: frame.height,
          source: frame.source,
          projectPath: contextResult.projectPath,
          xamlPath: contextResult.xamlPath,
        },
      };
    },
    async (xNorm, yNorm, navigateToSource) => {
      const contextResult = await resolveLivePreviewContext();
      if (!contextResult.ok) {
        return {
          ok: false as const,
          message: contextResult.message,
        };
      }

      const hit = await hitTestRuntimePreview(contextResult.projectPath, contextResult.xamlPath, xNorm, yNorm);
      if (!hit) {
        toolboxUi.clearPropertyGrid('No selectable element at this point.');
        return {
          ok: false as const,
          message: 'No selectable element at this point.',
        };
      }

      if (navigateToSource) {
        await revealLivePreviewSelection(contextResult.xamlPath, hit.elementName, hit.typeName);
      }

      return {
        ok: true as const,
        hit: {
          typeName: hit.typeName,
          elementName: hit.elementName,
          boundsX: hit.boundsX,
          boundsY: hit.boundsY,
          boundsWidth: hit.boundsWidth,
          boundsHeight: hit.boundsHeight,
          rootWidth: hit.rootWidth,
          rootHeight: hit.rootHeight,
        },
      };
    },
    async (xNorm, yNorm) => {
      const contextResult = await resolveLivePreviewContext();
      if (!contextResult.ok) {
        return {
          ok: false as const,
          message: contextResult.message,
        };
      }

      const hit = await hitTestRuntimePreview(contextResult.projectPath, contextResult.xamlPath, xNorm, yNorm);
      if (!hit) {
        return {
          ok: false as const,
          message: 'No selectable element at this point.',
        };
      }

      return {
        ok: true as const,
        hit: {
          typeName: hit.typeName,
          elementName: hit.elementName,
          boundsX: hit.boundsX,
          boundsY: hit.boundsY,
          boundsWidth: hit.boundsWidth,
          boundsHeight: hit.boundsHeight,
          rootWidth: hit.rootWidth,
          rootHeight: hit.rootHeight,
        },
      };
    },
    async (elementName, typeName) => {
      const contextResult = await resolveLivePreviewContext();
      if (!contextResult.ok) {
        toolboxUi.clearPropertyGrid(contextResult.message);
        return {
          ok: false as const,
          message: contextResult.message,
        };
      }

      const hit = await findRuntimePreviewElement(
        contextResult.projectPath,
        contextResult.xamlPath,
        elementName,
        typeName
      );
      if (!hit) {
        return {
          ok: false as const,
          message: 'Could not map current XAML selection to a live element.',
        };
      }

      return {
        ok: true as const,
        hit: {
          typeName: hit.typeName,
          elementName: hit.elementName,
          boundsX: hit.boundsX,
          boundsY: hit.boundsY,
          boundsWidth: hit.boundsWidth,
          boundsHeight: hit.boundsHeight,
          rootWidth: hit.rootWidth,
          rootHeight: hit.rootHeight,
        },
      };
    },
    async (elementName, typeName) => {
      const contextResult = await resolveLivePreviewContext();
      if (!contextResult.ok) {
        return {
          ok: false as const,
          message: contextResult.message,
        };
      }

      const properties = await inspectRuntimePreviewElement(
        contextResult.projectPath,
        contextResult.xamlPath,
        elementName,
        typeName
      );
      if (!properties) {
        toolboxUi.clearPropertyGrid('No runtime properties available for this selection.');
        return {
          ok: false as const,
          message: 'No runtime properties available for this selection.',
        };
      }

      toolboxUi.updatePropertyGrid({
        typeName: properties.typeName,
        elementName: properties.elementName,
        text: properties.text,
        background: properties.background,
        foreground: properties.foreground,
        width: properties.width,
        height: properties.height,
        actualWidth: properties.actualWidth,
        actualHeight: properties.actualHeight,
        margin: properties.margin,
        horizontalAlignment: properties.horizontalAlignment,
        verticalAlignment: properties.verticalAlignment,
        isEnabled: properties.isEnabled,
        visibility: properties.visibility,
      });

      return {
        ok: true as const,
        properties: {
          typeName: properties.typeName,
          elementName: properties.elementName,
          text: properties.text,
          background: properties.background,
          foreground: properties.foreground,
          width: properties.width,
          height: properties.height,
          actualWidth: properties.actualWidth,
          actualHeight: properties.actualHeight,
          margin: properties.margin,
          horizontalAlignment: properties.horizontalAlignment,
          verticalAlignment: properties.verticalAlignment,
          isEnabled: properties.isEnabled,
          visibility: properties.visibility,
          canEditText: properties.canEditText,
          canEditBackground: properties.canEditBackground,
          canEditForeground: properties.canEditForeground,
        },
      };
    },
    async (elementName, typeName, property, value, autoPush) => {
      const contextResult = await resolveLivePreviewContext();
      if (!contextResult.ok) {
        return {
          ok: false as const,
          message: contextResult.message,
        };
      }

      const applyResult = await applyLivePreviewPropertyEdit(
        contextResult.xamlPath,
        elementName,
        typeName,
        property,
        value,
        contextResult.projectPath,
        autoPush
      );

      if (!applyResult.ok) {
        return {
          ok: false as const,
          message: applyResult.message,
        };
      }

      return {
        ok: true as const,
        message: autoPush
          ? applyResult.message
          : `${applyResult.message} Click "WPF: Hot Reload" to push to the running app.`,
      };
    },
    async (xNorm, yNorm, item, autoPush) => {
      const contextResult = await resolveLivePreviewContext();
      if (!contextResult.ok) {
        return {
          ok: false as const,
          message: contextResult.message,
        };
      }

      const hit = await hitTestRuntimePreview(contextResult.projectPath, contextResult.xamlPath, xNorm, yNorm);
      if (!hit) {
        return {
          ok: false as const,
          message: 'No valid drop target at this point.',
        };
      }

      const insertResult = await applyLivePreviewToolboxInsert(
        contextResult.xamlPath,
        hit.elementName,
        hit.typeName,
        item as LivePreviewToolboxItem,
        contextResult.projectPath,
        autoPush
      );

      if (!insertResult.ok) {
        return {
          ok: false as const,
          message: insertResult.message,
        };
      }

      return {
        ok: true as const,
        message: autoPush
          ? insertResult.message
          : `${insertResult.message} Click "WPF: Hot Reload" to push to the running app.`,
      };
    },
    () => vscode.workspace.getConfiguration('wpf').get<boolean>('livePreviewAutoPush', false)
  );

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
        const hideHost = vscode.workspace.getConfiguration('wpf').get<boolean>('livePreviewHideRunningApp', true);
        if (hideHost) {
          await setRuntimePreviewHostVisibility(projectPath, false);
        }
        const xamlDocument = await vscode.workspace.openTextDocument(resource);
        const pushed = await pushRuntimeXamlUpdate(projectPath, xamlPath, xamlDocument.getText());
        if (pushed) {
          vscode.window.showInformationMessage(
            `Applied hot reload update for ${path.basename(xamlPath)}.`
          );
          if (livePreviewPanel.isOpen()) {
            void livePreviewPanel.refresh('hotReload');
          }
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

      const hideHost = vscode.workspace.getConfiguration('wpf').get<boolean>('livePreviewHideRunningApp', true);
      if (hideHost) {
        await setRuntimePreviewHostVisibility(projectPath, false);
      }

      vscode.window.showInformationMessage(
        `Started WPF hot reload session for ${path.basename(projectPath)}. Once the app finishes loading, click Hot Reload again to push the current XAML file.`
      );
      if (livePreviewPanel.isOpen()) {
        void livePreviewPanel.refresh('sessionStart');
      }
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

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.openXamlFile', async (uri?: vscode.Uri) => {
      const explicitProjectPath =
        uri?.scheme === 'file' && uri.fsPath.toLowerCase().endsWith('.csproj')
          ? uri.fsPath
          : null;
      const activePath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
        ? vscode.window.activeTextEditor.document.uri.fsPath
        : undefined;

      let projectPath: string | null = explicitProjectPath;
      if (!projectPath && activePath) {
        projectPath = getCachedProject(activePath) ?? null;
        if (!projectPath && activePath.toLowerCase().endsWith('.xaml')) {
          projectPath = await findProjectForFile(activePath);
        }
      }

      if (!projectPath) {
        const knownProjects = Array.from(new Set(selectedProjects.values()));
        if (knownProjects.length === 1) {
          projectPath = knownProjects[0];
        } else {
          const projects = await findProjectsInWorkspace();
          const picked = await showProjectPicker(projects);
          projectPath = picked ?? null;
        }
      }

      if (!projectPath) {
        vscode.window.showWarningMessage('No WPF project selected.');
        return;
      }

      const xamlFiles = collectProjectXamlFiles(projectPath);
      if (xamlFiles.length === 0) {
        vscode.window.showWarningMessage(`No XAML files found for ${path.basename(projectPath)}.`);
        return;
      }

      const items = xamlFiles.map(file => ({
        label: path.basename(file),
        description: vscode.workspace.asRelativePath(file),
        detail: file,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Open XAML file from ${path.basename(projectPath)}`,
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!picked) {
        return;
      }

      try {
        const uri = vscode.Uri.file(picked.detail);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open XAML file: ${String(err)}`);
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
    vscode.commands.registerCommand('wpf.refreshLivePreview', async () => {
      if (!livePreviewPanel.isOpen()) {
        livePreviewPanel.open();
      }
      await livePreviewPanel.refresh('manual');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.openLivePreview', async () => {
      livePreviewPanel.open();
    })
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

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf._test.isWpfProject', (projectPath?: string) => {
      if (!projectPath) { return false; }
      return isWpfProject(projectPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf._test.parseProject', (projectPath?: string) => {
      if (!projectPath) { return null; }
      return parseProject(projectPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf._test.pushRuntimeXamlUpdate', async (projectPath?: string, xamlPath?: string, xamlText?: string) => {
      if (!projectPath || !xamlPath || !xamlText) { return false; }
      return pushRuntimeXamlUpdate(projectPath, xamlPath, xamlText);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'wpf._test.applyLivePreviewToolboxInsert',
      async (args?: {
        xamlPath?: string;
        elementName?: string;
        typeName?: string;
        item?: LivePreviewToolboxItem;
      }) => {
        const xamlPath = args?.xamlPath;
        const elementName = args?.elementName;
        const typeName = args?.typeName;
        const item = args?.item;
        if (!xamlPath || !typeName || !item) {
          return {
            ok: false,
            message: 'wpf._test.applyLivePreviewToolboxInsert requires xamlPath, typeName, and item.',
          };
        }

        return applyLivePreviewToolboxInsert(
          xamlPath,
          elementName ?? '',
          typeName,
          item,
          '',
          false
        );
      }
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

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      schedulePreviewSelectionSync(event.textEditor, event.selections, livePreviewPanel);
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

function resolveLivePreviewResource(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor;
  if (
    active &&
    active.document.uri.scheme === 'file' &&
    active.document.languageId === 'xaml' &&
    isWpfXaml(active.document.uri.fsPath)
  ) {
    return active.document.uri;
  }

  for (const editor of vscode.window.visibleTextEditors) {
    if (
      editor.document.uri.scheme === 'file' &&
      editor.document.languageId === 'xaml' &&
      isWpfXaml(editor.document.uri.fsPath)
    ) {
      return editor.document.uri;
    }
  }

  if (lastLivePreviewXamlPath && fs.existsSync(lastLivePreviewXamlPath) && isWpfXaml(lastLivePreviewXamlPath)) {
    return vscode.Uri.file(lastLivePreviewXamlPath);
  }

  return undefined;
}

export async function deactivate(): Promise<void> {
  for (const timer of hotReloadTimers.values()) {
    clearTimeout(timer);
  }
  hotReloadTimers.clear();
  for (const timer of previewSelectionSyncTimers.values()) {
    clearTimeout(timer);
  }
  previewSelectionSyncTimers.clear();
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

async function revealLivePreviewSelection(
  xamlPath: string,
  elementName: string,
  typeName: string
): Promise<void> {
  try {
    const fallbackUri = vscode.Uri.file(xamlPath);
    const mappedResult = await tryResolveAxsgMappedRange(fallbackUri, elementName, typeName);
    if (typeof mappedResult.rejectedConfidence === 'number') {
      showLivePreviewMappingHint(
        `WPF Live Preview: AXSG mapping confidence ${mappedResult.rejectedConfidence.toFixed(2)} is below threshold; using fallback mapping.`
      );
    }

    const mappedRange = mappedResult.mapped;
    const targetUri = mappedRange?.uri ?? fallbackUri;
    const document = await vscode.workspace.openTextDocument(targetUri);
    const range = mappedRange?.range ?? findElementRangeInDocument(document, elementName, typeName);
    if (!range) {
      showLivePreviewMappingHint('WPF Live Preview: selection mapping is ambiguous. Add unique x:Name/Name for stable sync.');
      return;
    }

    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true,
      preview: false,
    });

    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    // Best-effort selection sync only; preview hit-test remains functional even if reveal fails.
  }
}

async function tryResolveAxsgMappedRange(
  xamlUri: vscode.Uri,
  elementName: string,
  typeName: string
): Promise<{ mapped: { uri: vscode.Uri; range: vscode.Range } | null; rejectedConfidence?: number }> {
  const mapped = await getHotReloadMapDocument(xamlUri, elementName, typeName);
  if (!mapped?.range?.start || !mapped.range.end) {
    return { mapped: null };
  }

  const mappedUri = typeof mapped.uri === 'string' && mapped.uri.trim().length > 0
    ? vscode.Uri.parse(mapped.uri)
    : xamlUri;

  const start = mapped.range.start;
  const end = mapped.range.end;
  if (start.line < 0 || start.character < 0 || end.line < 0 || end.character < 0) {
    return { mapped: null };
  }

  const confidence = typeof mapped.confidence === 'number' ? mapped.confidence : undefined;
  if (typeof confidence === 'number' && confidence < axsgMapConfidenceThreshold) {
    return {
      mapped: null,
      rejectedConfidence: confidence,
    };
  }

  return {
    mapped: {
      uri: mappedUri,
      range: new vscode.Range(
        new vscode.Position(start.line, start.character),
        new vscode.Position(end.line, end.character)
      ),
    },
  };
}

function showLivePreviewMappingHint(message: string): void {
  const now = Date.now();
  if (
    message === lastLivePreviewHintText &&
    now - lastLivePreviewHintAt < livePreviewHintCooldownMs
  ) {
    return;
  }

  lastLivePreviewHintAt = now;
  lastLivePreviewHintText = message;
  vscode.window.setStatusBarMessage(message, livePreviewMappingHintDurationMs);
}

function findElementRangeInDocument(
  document: vscode.TextDocument,
  elementName: string,
  typeName: string
): vscode.Range | null {
  const text = document.getText();
  const byName = findByElementName(text, elementName);
  if (byName) {
    return new vscode.Range(document.positionAt(byName), document.positionAt(byName));
  }

  const byType = findByElementType(text, typeName);
  if (byType) {
    return new vscode.Range(document.positionAt(byType), document.positionAt(byType));
  }

  return null;
}

function findByElementName(text: string, elementName: string): number | null {
  const trimmedName = elementName.trim();
  if (!trimmedName) {
    return null;
  }

  const escaped = escapeRegExp(trimmedName);
  const matches = collectMatchOffsets(
    text,
    new RegExp(
      `<(?:[\\w-]+:)?[\\w.-]+\\b[^>]*\\b(?:x:Name|Name)\\s*=\\s*["']${escaped}["'][^>]*>`,
      'g'
    )
  );
  return matches.length === 1 ? matches[0] : null;
}

function findByElementType(text: string, typeName: string): number | null {
  const shortType = typeName.split(/[.+]/).filter(Boolean).pop();
  if (!shortType) {
    return null;
  }

  const escaped = escapeRegExp(shortType);
  const matches = collectMatchOffsets(
    text,
    new RegExp(`<(?:[\\w-]+:)?${escaped}\\b`, 'g')
  );
  return matches.length === 1 ? matches[0] : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectMatchOffsets(text: string, pattern: RegExp): number[] {
  const offsets: number[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text)) !== null) {
    offsets.push(match.index);
  }

  return offsets;
}

function schedulePreviewSelectionSync(
  editor: vscode.TextEditor,
  selections: readonly vscode.Selection[],
  livePreviewPanel: WpfLivePreviewPanel
): void {
  const key = editor.document.uri.toString();
  const existing = previewSelectionSyncTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  previewSelectionSyncTimers.set(
    key,
    setTimeout(() => {
      previewSelectionSyncTimers.delete(key);
      void syncPreviewSelectionFromEditor(editor, selections, livePreviewPanel);
    }, 120)
  );
}

async function syncPreviewSelectionFromEditor(
  editor: vscode.TextEditor,
  selections: readonly vscode.Selection[],
  livePreviewPanel: WpfLivePreviewPanel
): Promise<void> {
  if (!livePreviewPanel.isOpen()) {
    return;
  }

  const document = editor.document;
  if (document.languageId !== 'xaml' || document.uri.scheme !== 'file') {
    return;
  }

  if (!isWpfXaml(document.uri.fsPath)) {
    return;
  }

  const selection = selections[0];
  if (!selection) {
    return;
  }

  const query = extractSelectionQuery(document, selection.active);
  if (!query) {
    return;
  }

  if (!query.elementName) {
    // Type-only matching is too ambiguous in many trees, so skip auto-sync.
    showLivePreviewMappingHint('WPF Live Preview: cursor is not on a uniquely named element; reverse sync skipped.');
    return;
  }

  if (!isUniqueElementName(document.getText(), query.elementName)) {
    showLivePreviewMappingHint(
      `WPF Live Preview: element name "${query.elementName}" is ambiguous in this file; reverse sync skipped.`
    );
    return;
  }

  await livePreviewPanel.syncSelection(query.elementName, query.typeName);
}

function extractSelectionQuery(
  document: vscode.TextDocument,
  position: vscode.Position
): { elementName: string; typeName: string } | null {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const scan = text.slice(0, offset);

  const tagPattern = /<(?!\/|!|\?)(?:([\w.-]+):)?([\w.-]+)\b([^<>]*)>/g;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((match = tagPattern.exec(scan)) !== null) {
    last = match;
  }

  if (!last) {
    return null;
  }

  const typeName = last[2] ?? '';
  if (!typeName) {
    return null;
  }

  const attributes = last[3] ?? '';
  const nameMatch = /\b(?:x:Name|Name)\s*=\s*["']([^"']+)["']/.exec(attributes);
  const elementName = nameMatch?.[1]?.trim() ?? '';

  return { elementName, typeName };
}

function isUniqueElementName(text: string, elementName: string): boolean {
  const escaped = escapeRegExp(elementName.trim());
  if (!escaped) {
    return false;
  }

  const matches = collectMatchOffsets(
    text,
    new RegExp(`\\b(?:x:Name|Name)\\s*=\\s*["']${escaped}["']`, 'g')
  );
  return matches.length === 1;
}

async function applyLivePreviewPropertyEdit(
  xamlPath: string,
  elementName: string,
  typeName: string,
  property: 'Text' | 'Background' | 'Foreground',
  value: string,
  projectPath: string,
  autoPush: boolean
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const inspected = await inspectRuntimePreviewElement(projectPath, xamlPath, elementName, typeName);
  if (inspected) {
    const allowed = property === 'Text'
      ? inspected.canEditText
      : property === 'Background'
        ? inspected.canEditBackground
        : inspected.canEditForeground;
    if (!allowed) {
      return {
        ok: false,
        message: `Selected element does not support ${property} editing.`,
      };
    }
  }

  const normalized = normalizeLivePreviewPropertyValue(property, value);
  if (!normalized.ok) {
    return {
      ok: false,
      message: normalized.message,
    };
  }

  const uri = vscode.Uri.file(xamlPath);
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();

  const tagMatch = findTargetOpeningTag(text, elementName, typeName);
  if (!tagMatch) {
    return {
      ok: false,
      message: 'Could not find a unique target element in XAML.',
    };
  }

  const resolvedProperty = resolveApplyPropertyName(property, tagMatch.tagName);
  const escapedValue = escapeXmlAttribute(normalized.value);
  const updatedTag = setOrInsertAttribute(tagMatch.tagText, resolvedProperty, escapedValue);
  if (updatedTag === tagMatch.tagText) {
    return {
      ok: true,
      message: 'No change needed.',
    };
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(tagMatch.start), document.positionAt(tagMatch.end)),
    updatedTag
  );

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    return {
      ok: false,
      message: 'Failed to apply XAML edit.',
    };
  }

  if (autoPush) {
    const updatedDocument = await vscode.workspace.openTextDocument(uri);
    const pushed = await pushRuntimeXamlUpdate(projectPath, xamlPath, updatedDocument.getText());
    if (!pushed) {
      return {
        ok: false,
        message: `Updated ${resolvedProperty}, but hot reload push failed.`,
      };
    }
  }

  return {
    ok: true,
    message: autoPush
      ? `Updated ${resolvedProperty} and pushed hot reload.`
      : `Updated ${resolvedProperty} on selected element.`,
  };
}

function findTargetOpeningTag(
  text: string,
  elementName: string,
  typeName: string
): { start: number; end: number; tagText: string; tagName: string } | null {
  const byName = findOpeningTagByName(text, elementName);
  if (byName) {
    return byName;
  }

  return findOpeningTagByType(text, typeName);
}

function findOpeningTagByName(
  text: string,
  elementName: string
): { start: number; end: number; tagText: string; tagName: string } | null {
  const name = elementName.trim();
  if (!name) {
    return null;
  }

  const escaped = escapeRegExp(name);
  const pattern = new RegExp(
    `<((?:[\\w.-]+:)?[\\w.-]+)\\b[^>]*\\b(?:x:Name|Name)\\s*=\\s*["']${escaped}["'][^>]*>`,
    'g'
  );

  return findUniqueTagMatch(text, pattern);
}

function findOpeningTagByType(
  text: string,
  typeName: string
): { start: number; end: number; tagText: string; tagName: string } | null {
  const shortType = typeName.split(/[.+]/).filter(Boolean).pop();
  if (!shortType) {
    return null;
  }

  const escaped = escapeRegExp(shortType);
  const pattern = new RegExp(`<((?:[\\w.-]+:)?${escaped})\\b[^>]*>`, 'g');
  return findUniqueTagMatch(text, pattern);
}

function findUniqueTagMatch(
  text: string,
  pattern: RegExp
): { start: number; end: number; tagText: string; tagName: string } | null {
  let match: RegExpExecArray | null = null;
  let found: RegExpExecArray | null = null;
  let count = 0;
  while ((match = pattern.exec(text)) !== null) {
    count++;
    if (count > 1) {
      return null;
    }
    found = match;
  }

  if (!found || !found[1]) {
    return null;
  }

  return {
    start: found.index,
    end: found.index + found[0].length,
    tagText: found[0],
    tagName: found[1],
  };
}

function resolveApplyPropertyName(
  property: 'Text' | 'Background' | 'Foreground',
  tagName: string
): 'Text' | 'Content' | 'Background' | 'Foreground' {
  if (property === 'Background') {
    return 'Background';
  }
  if (property === 'Foreground') {
    return 'Foreground';
  }

  const bare = tagName.includes(':') ? tagName.split(':').pop() ?? tagName : tagName;
  if (bare === 'Button' || bare === 'Label' || bare === 'CheckBox' || bare === 'RadioButton') {
    return 'Content';
  }

  return 'Text';
}

function setOrInsertAttribute(tagText: string, attributeName: string, attributeValue: string): string {
  const attrPattern = new RegExp(`\\b${escapeRegExp(attributeName)}\\s*=\\s*["'][^"']*["']`);
  if (!attributeValue) {
    if (!attrPattern.test(tagText)) {
      return tagText;
    }

    const removed = tagText.replace(attrPattern, '').replace(/\s{2,}/g, ' ');
    return removed.replace(/\s+\/>/g, ' />').replace(/\s+>/g, '>');
  }

  const rendered = `${attributeName}="${attributeValue}"`;

  if (attrPattern.test(tagText)) {
    return tagText.replace(attrPattern, rendered);
  }

  const closeToken = tagText.endsWith('/>') ? '/>' : '>';
  const insertionPoint = tagText.length - closeToken.length;
  return `${tagText.slice(0, insertionPoint)} ${rendered}${tagText.slice(insertionPoint)}`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeLivePreviewPropertyValue(
  property: 'Text' | 'Background' | 'Foreground',
  value: string
): { ok: true; value: string } | { ok: false; message: string } {
  if (property === 'Text') {
    return { ok: true, value };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    // Empty brush means clear attribute in XAML.
    return { ok: true, value: '' };
  }

  if (/[\r\n]/.test(trimmed)) {
    return {
      ok: false,
      message: `${property} value cannot contain line breaks.`,
    };
  }

  if (/[<>]/.test(trimmed)) {
    return {
      ok: false,
      message: `${property} value contains unsupported characters.`,
    };
  }

  return { ok: true, value: trimmed };
}

function collectProjectXamlFiles(projectPath: string): string[] {
  const projectDir = path.dirname(projectPath);
  const collected = new Set<string>();

  try {
    const xml = fs.readFileSync(projectPath, 'utf8');
    const includePattern = /<(?:Page|ApplicationDefinition|Resource|Content|None)\b[^>]*\b(?:Include|Update)\s*=\s*["']([^"']+\.xaml)["'][^>]*>/ig;
    let match: RegExpExecArray | null;
    while ((match = includePattern.exec(xml)) !== null) {
      const relative = match[1];
      if (!relative) {
        continue;
      }

      const normalized = relative.replace(/[\\/]/g, path.sep);
      const absolute = path.resolve(projectDir, normalized);
      if (fs.existsSync(absolute)) {
        collected.add(absolute);
      }
    }
  } catch {
    // fall back to disk scan only
  }

  const pending = [projectDir];
  const ignored = new Set(['bin', 'obj', '.git', 'node_modules', '.vs']);
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          pending.push(full);
        }
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith('.xaml')) {
        collected.add(full);
      }
    }
  }

  return Array.from(collected).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function applyLivePreviewToolboxInsert(
  xamlPath: string,
  elementName: string,
  typeName: string,
  item: LivePreviewToolboxItem,
  projectPath: string,
  autoPush: boolean
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const snippet = (item.defaultSnippet ?? '').trim();
  if (!snippet.startsWith('<')) {
    return {
      ok: false,
      message: 'Toolbox item does not contain valid XAML snippet content.',
    };
  }

  const uri = vscode.Uri.file(xamlPath);
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const target = findTargetOpeningTag(text, elementName, typeName);
  if (!target) {
    return {
      ok: false,
      message: 'Could not map preview drop target to a unique XAML element.',
    };
  }

  const lineBreak = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const rootIndent = getIndentForOffset(document, target.start);
  const childIndent = `${rootIndent}    `;
  const prepared = prepareSnippetForTarget(document, item, snippet);
  if (!prepared.ok) {
    return {
      ok: false,
      message: prepared.message,
    };
  }

  const insertion = buildContainerInsertion(text, target, prepared.snippet, rootIndent, childIndent, lineBreak);
  let plannedInsertion = insertion;
  let appliedTarget = target;
  if (!plannedInsertion.ok) {
    const ancestor = findNearestSupportedAncestorTarget(text, target.start);
    if (ancestor) {
      const ancestorRootIndent = getIndentForOffset(document, ancestor.start);
      const ancestorChildIndent = `${ancestorRootIndent}    `;
      const fallback = buildContainerInsertion(
        text,
        ancestor,
        prepared.snippet,
        ancestorRootIndent,
        ancestorChildIndent,
        lineBreak
      );
      if (fallback.ok) {
        plannedInsertion = fallback;
        appliedTarget = ancestor;
      }
    }
  }

  if (!plannedInsertion.ok) {
    return {
      ok: false,
      message: plannedInsertion.message,
    };
  }

  const edit = new vscode.WorkspaceEdit();
  if (prepared.namespaceInsertion) {
    edit.insert(uri, prepared.namespaceInsertion.position, prepared.namespaceInsertion.text);
  }
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(plannedInsertion.replaceStart), document.positionAt(plannedInsertion.replaceEnd)),
    plannedInsertion.newText
  );

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    return {
      ok: false,
      message: 'Failed to apply toolbox insertion edit.',
    };
  }

  if (autoPush) {
    const updatedDocument = await vscode.workspace.openTextDocument(uri);
    const pushed = await pushRuntimeXamlUpdate(projectPath, xamlPath, updatedDocument.getText());
    if (!pushed) {
      return {
        ok: false,
        message: `Inserted ${item.displayName}, but hot reload push failed.`,
      };
    }
  }

  return {
    ok: true,
    message: autoPush
      ? `Inserted ${item.displayName} and pushed hot reload.`
      : `Inserted ${item.displayName} into ${stripTagPrefix(appliedTarget.tagName)}.`,
  };
}

function buildContainerInsertion(
  text: string,
  target: { start: number; end: number; tagText: string; tagName: string },
  snippet: string,
  rootIndent: string,
  childIndent: string,
  lineBreak: string
): { ok: true; replaceStart: number; replaceEnd: number; newText: string } | { ok: false; message: string } {
  const tagName = target.tagName;
  const bare = stripTagPrefix(tagName);
  const isSelfClosing = /\/\s*>$/.test(target.tagText);
  const childText = indentSnippet(snippet, childIndent, lineBreak);

  if (isPanelLike(bare) || isItemsLike(bare)) {
    if (isSelfClosing) {
      const open = target.tagText.replace(/\/\s*>$/, '>');
      return {
        ok: true,
        replaceStart: target.start,
        replaceEnd: target.end,
        newText: `${open}${lineBreak}${childText}${lineBreak}${rootIndent}</${tagName}>`,
      };
    }

    const close = findMatchingClosingTag(text, target.end, tagName);
    if (!close) {
      return {
        ok: false,
        message: `Could not locate closing tag for ${tagName}.`,
      };
    }

    return {
      ok: true,
      replaceStart: close.start,
      replaceEnd: close.start,
      newText: `${lineBreak}${childText}${lineBreak}${rootIndent}`,
    };
  }

  if (isContentLike(bare)) {
    if (isSelfClosing) {
      const hasInlineContentAttribute = /\bContent\s*=\s*["'][^"']*["']/.test(target.tagText);
      if (hasInlineContentAttribute) {
        return {
          ok: false,
          message: `${bare} already has content; choose a Panel/ItemsControl target instead.`,
        };
      }

      const open = target.tagText.replace(/\/\s*>$/, '>');
      return {
        ok: true,
        replaceStart: target.start,
        replaceEnd: target.end,
        newText: `${open}${lineBreak}${childText}${lineBreak}${rootIndent}</${tagName}>`,
      };
    }

    const close = findMatchingClosingTag(text, target.end, tagName);
    if (!close) {
      return {
        ok: false,
        message: `Could not locate closing tag for ${tagName}.`,
      };
    }

    const inner = text.slice(target.end, close.start);
    if (inner.trim().length > 0) {
      return {
        ok: false,
        message: `${bare} already has content; choose a Panel/ItemsControl target instead.`,
      };
    }

    return {
      ok: true,
      replaceStart: target.end,
      replaceEnd: close.start,
      newText: `${lineBreak}${childText}${lineBreak}${rootIndent}`,
    };
  }

  return {
    ok: false,
    message: `${bare} is not a supported placement target yet.`,
  };
}

function findMatchingClosingTag(
  text: string,
  fromIndex: number,
  tagName: string
): { start: number; end: number } | null {
  const pattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, 'g');
  pattern.lastIndex = fromIndex;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0];
    const isClose = token.startsWith('</');
    const isSelf = /\/\s*>$/.test(token);
    if (isClose) {
      depth--;
      if (depth === 0) {
        return {
          start: match.index,
          end: match.index + token.length,
        };
      }
      continue;
    }

    if (!isSelf) {
      depth++;
    }
  }

  return null;
}

function findNearestSupportedAncestorTarget(
  text: string,
  offset: number
): { start: number; end: number; tagText: string; tagName: string } | null {
  const tokenPattern = /<((?:[\w.-]+:)?[\w.-]+)\b[^>]*>|<\/((?:[\w.-]+:)?[\w.-]+)\s*>/g;
  const stack: Array<{ start: number; end: number; tagText: string; tagName: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index >= offset) {
      break;
    }

    const openName = match[1];
    const closeName = match[2];
    const token = match[0];
    if (openName) {
      const selfClosing = /\/\s*>$/.test(token);
      if (!selfClosing) {
        stack.push({
          start: match.index,
          end: match.index + token.length,
          tagText: token,
          tagName: openName,
        });
      }
      continue;
    }

    if (closeName) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tagName === closeName) {
          stack.splice(i, 1);
          break;
        }
      }
    }
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    const candidate = stack[i];
    const bare = stripTagPrefix(candidate.tagName);
    if (isPanelLike(bare) || isItemsLike(bare) || isContentLike(bare)) {
      return candidate;
    }
  }

  return null;
}

function indentSnippet(snippet: string, indent: string, lineBreak: string): string {
  const normalized = snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized
    .split('\n')
    .map(line => `${indent}${line}`)
    .join(lineBreak);
}

function stripTagPrefix(tagName: string): string {
  return tagName.includes(':') ? tagName.split(':').pop() ?? tagName : tagName;
}

function isPanelLike(name: string): boolean {
  return name === 'Grid'
    || name === 'StackPanel'
    || name === 'DockPanel'
    || name === 'WrapPanel'
    || name === 'UniformGrid'
    || name === 'Canvas';
}

function isItemsLike(name: string): boolean {
  return name === 'ItemsControl'
    || name === 'ListBox'
    || name === 'ComboBox'
    || name === 'TreeView'
    || name === 'TabControl'
    || name === 'ListView'
    || name === 'Menu'
    || name === 'ContextMenu';
}

function isContentLike(name: string): boolean {
  return name === 'Border'
    || name === 'ContentControl'
    || name === 'Button'
    || name === 'Label'
    || name === 'CheckBox'
    || name === 'RadioButton'
    || name === 'GroupBox'
    || name === 'Expander'
    || name === 'ScrollViewer'
    || name === 'Viewbox'
    || name === 'Window'
    || name === 'UserControl'
    || name === 'TabItem';
}

function getIndentForOffset(document: vscode.TextDocument, offset: number): string {
  const line = document.positionAt(offset).line;
  const text = document.lineAt(line).text;
  const match = text.match(/^\s*/);
  return match ? match[0] : '';
}

function prepareSnippetForTarget(
  document: vscode.TextDocument,
  item: LivePreviewToolboxItem,
  snippet: string
):
  | {
    ok: true;
    snippet: string;
    namespaceInsertion?: { position: vscode.Position; text: string };
  }
  | { ok: false; message: string } {
  if (!item.requiresPrefix || !item.clrNamespace) {
    return { ok: true, snippet };
  }

  const root = findRootStartTagRange(document.getText());
  if (!root) {
    return { ok: true, snippet };
  }

  const clrValue = buildClrNamespaceValue(item.clrNamespace, item.assemblyName);
  const declarations = parseXmlnsDeclarations(root.text);
  const existing = declarations.find(d => normalizeNamespaceValue(d.value) === normalizeNamespaceValue(clrValue));
  if (existing) {
    return {
      ok: true,
      snippet: replaceSnippetPrefix(
        snippet,
        item.prefixHint ?? 'local',
        existing.prefix ?? item.prefixHint ?? 'local'
      ),
    };
  }

  const preferred = item.prefixHint ?? 'local';
  const used = new Set(declarations.map(d => d.prefix).filter((v): v is string => Boolean(v)));
  let candidate = preferred;
  let index = 1;
  while (used.has(candidate)) {
    candidate = `${preferred}${index}`;
    index++;
  }

  const rootIndent = getIndentForOffset(document, root.startOffset);
  const lineBreak = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const insertPos = document.positionAt(root.endOffset);
  const namespaceText = `${lineBreak}${rootIndent}    xmlns:${candidate}="${clrValue}"`;
  return {
    ok: true,
    snippet: replaceSnippetPrefix(snippet, item.prefixHint ?? 'local', candidate),
    namespaceInsertion: { position: insertPos, text: namespaceText },
  };
}

function buildClrNamespaceValue(clrNamespace: string, assemblyName?: string): string {
  if (assemblyName && assemblyName.trim().length > 0) {
    return `clr-namespace:${clrNamespace};assembly=${assemblyName}`;
  }

  return `clr-namespace:${clrNamespace}`;
}

interface XmlnsDeclaration {
  readonly prefix?: string;
  readonly value: string;
}

function parseXmlnsDeclarations(startTagText: string): XmlnsDeclaration[] {
  const declarations: XmlnsDeclaration[] = [];
  const regex = /\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(startTagText)) !== null) {
    const prefix = match[1];
    const value = (match[3] ?? match[4] ?? '').trim();
    declarations.push({ prefix, value });
  }

  return declarations;
}

function normalizeNamespaceValue(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function replaceSnippetPrefix(snippet: string, fromPrefix: string, toPrefix: string): string {
  if (fromPrefix === toPrefix) {
    return snippet;
  }

  const open = new RegExp(`<${escapeRegExp(fromPrefix)}:`, 'g');
  const close = new RegExp(`</${escapeRegExp(fromPrefix)}:`, 'g');
  return snippet.replace(open, `<${toPrefix}:`).replace(close, `</${toPrefix}:`);
}

function findRootStartTagRange(text: string): { startOffset: number; endOffset: number; text: string } | undefined {
  let start = 0;
  while (start < text.length) {
    const idx = text.indexOf('<', start);
    if (idx < 0 || idx + 1 >= text.length) {
      return undefined;
    }

    const next = text[idx + 1];
    if (next === '?' || next === '!' || next === '/') {
      start = idx + 1;
      continue;
    }

    const end = findTagClose(text, idx);
    if (end < 0) {
      return undefined;
    }

    return {
      startOffset: idx,
      endOffset: end,
      text: text.slice(idx, end + 1),
    };
  }

  return undefined;
}

function findTagClose(text: string, startOffset: number): number {
  let quote: '"' | '\'' | undefined;
  for (let i = startOffset + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }

    if (ch === '>') {
      return i;
    }
  }

  return -1;
}

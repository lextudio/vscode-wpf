import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
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
  setEventHandlerCallback,
} from './designerLauncher';
import { disposeStatusBar, getStatusBarItem, updateStatusBar } from './statusBar';
import {
  getDesignerProjectContext,
  getLanguageServerClient,
  startLanguageServer,
  stopLanguageServer,
} from './languageServer';
import { getPreferredDotnetPath } from './dotnetBootstrap';
import {
  getRuntimeSessionInfo,
  hasRunningRuntimeSession,
  pushRuntimeXamlUpdate,
  pushRuntimeXamlUpdateDetailed,
  registerRuntimeHotReload,
  startRuntimeHotReloadSessionWithDebugger,
  showRuntimeHotReloadOutput,
} from './runtimeHotReload';
import { registerToolbox } from './toolbox';
import { startReviewPromptScheduler } from './reviewPrompt';
import { resolveSharpDbgAdapter, promptInstallSharpDbg } from './sharpdbgAdapter';

// Per-workspace-folder project selection, keyed by workspace folder path.
const selectedProjects = new Map<string, string>();
const designerLaunchOperations = new Set<string>();
const hotReloadTimers = new Map<string, NodeJS.Timeout>();
let eventHandlerLogChannel: vscode.OutputChannel | undefined;

type CodeBehindLanguage = 'csharp' | 'vb' | 'fsharp';

function getEventHandlerLog(): vscode.OutputChannel {
  if (!eventHandlerLogChannel) {
    eventHandlerLogChannel = vscode.window.createOutputChannel('WPF Event Handler');
  }

  return eventHandlerLogChannel;
}

function logEventHandler(message: string): void {
  getEventHandlerLog().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('VS Code WPF extension is now active.');

  // On Windows start the language server immediately.
  // On non-Windows, checkWindowsTargetingForWorkspace runs the analyzer first
  // and only starts the server once project compatibility is confirmed.
  if (process.platform === 'win32') {
    startLanguageServer(context);
  }
  void checkWindowsTargetingForWorkspace(context);
  registerRuntimeHotReload(context);
  registerToolbox(context);
  startReviewPromptScheduler(context);

  // Recommend XAMLStyler extension for XAML formatting
  recommendXamlStyler(context);

  // Handle event handler creation requests from the visual designer.
  setEventHandlerCallback(async msg => {
    logEventHandler(
      `Request received. xaml='${msg.xamlPath}', event='${msg.eventName}', handler='${msg.handlerName}'`
    );

    const codeBehindPath = resolveCodeBehindPath(msg.xamlPath);
    if (!codeBehindPath) {
      logEventHandler(`Code-behind file not found for: ${msg.xamlPath}`);
      vscode.window.showErrorMessage(
        `Code-behind file not found for: ${path.basename(msg.xamlPath)}`
      );
      return;
    }
    const codeBehindLanguage = getCodeBehindLanguage(codeBehindPath);

    await startLanguageServer(context);
    logEventHandler('Language server start/ensure requested.');

    const lsPosition =
      await tryInsertEventHandlerViaLanguageServer(msg.xamlPath, msg.eventName, msg.handlerName);
    const position = lsPosition ?? await tryInsertEventHandlerFallback(
      codeBehindPath,
      codeBehindLanguage,
      msg.handlerName,
      msg.eventArgType
    );

    if (!lsPosition) {
      logEventHandler('Language-server insertion path did not return a position; fallback path attempted.');
    }

    if (!position) {
      logEventHandler('Insertion failed: language-server flow returned no position.');
      vscode.window.showErrorMessage(
        `Could not insert event handler in ${path.basename(codeBehindPath)}. ` +
        'Ensure the WPF XAML language server is running and retry.'
      );
      return;
    }
    logEventHandler(`Insertion succeeded at ${codeBehindPath}:${position.line + 1}:${position.character + 1}`);

    const uri = vscode.Uri.file(codeBehindPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  });

  // -------------------------------------------------------------------------
  // Command: wpf.launchDesigner
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.launchDesigner', async (uri?: vscode.Uri) => {
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
      const projectPath = await resolveProjectForAction(resource);
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

      if (designerLaunchOperations.has(projectPath)) {
        vscode.window.showInformationMessage(
          `Designer launch is already in progress for ${path.basename(projectPath)}.`
        );
        return;
      }

      designerLaunchOperations.add(projectPath);

      try {

        // 2. Check designer binary exists before potentially long build.
        const exeExists = getDesignerExecutable(context, projectPath) !== null;

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
        const autoBuild = getAutoBuildOnDesignerLaunch(cfg);
        const outputsUpToDate = areProjectOutputsUpToDate(projectPath);
        const hasRunningSession = hasRunningDesignerSession(projectPath);
        const blockingDiagnostics = vscode.languages
          .getDiagnostics(resource)
          .filter(d =>
            d.severity === vscode.DiagnosticSeverity.Error &&
            (d.source === 'MSBuildWorkspace' || d.source === 'AXSG.Semantic'));

        if (blockingDiagnostics.length > 0 && outputsUpToDate) {
          vscode.window.showErrorMessage(
            'Designer launch is blocked because the language server reports XAML/project errors for the current file.'
          );
          return;
        }

        if (autoBuild && !outputsUpToDate && !hasRunningSession) {
          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Building ${path.basename(projectPath)} for Designer…`,
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
            'Designer is already running, so the extension sent a live XAML update without rebuilding. Use "WPF: Rebuild and Restart Designer" after code or project changes.'
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
        designerLaunchOperations.delete(projectPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.previewXaml', async (uri?: vscode.Uri) => {
      return vscode.commands.executeCommand('wpf.launchDesigner', uri);
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

      const projectPath = await resolveProjectForAction(resource);
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

      const projectPath = await resolveProjectForAction(resource);
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
      const started = await startRuntimeHotReloadSessionWithDebugger(context, projectPath, xamlPath);
      if (!started) {
        return;
      }

      vscode.window.showInformationMessage(
        `Started WPF hot reload + debug session for ${path.basename(projectPath)}. Once the app finishes loading, click Hot Reload again to push the current XAML file.`
      );
    })
  );

  // ── Hot Reload with SharpDbg debugger ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.hotReloadDebug', async (uri?: vscode.Uri) => {
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

      const projectPath = await resolveProjectForAction(resource);
      if (!projectPath) {
        return;
      }

      if (!isWpfProject(projectPath)) {
        vscode.window.showErrorMessage(
          `"${path.basename(projectPath)}" is not a WPF project.`
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
      const started = await startRuntimeHotReloadSessionWithDebugger(context, projectPath, xamlPath);
      if (!started) {
        return;
      }

      vscode.window.showInformationMessage(
        `Started WPF hot reload + debug session for ${path.basename(projectPath)}. ` +
        'Set breakpoints and click Hot Reload to push XAML updates.'
      );
    })
  );

  // ── SharpDbg Debug Adapter Provider ───────────────────────────────────
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('wpf-sharpdbg', {
      async createDebugAdapterDescriptor(session: vscode.DebugSession) {
        let isFramework = !!(session.configuration && session.configuration.isFramework);

        // If the caller didn't explicitly mark the session, try to infer from the provided project/program.
        if (!isFramework) {
          const projPath = session.configuration?.projectPath ?? (session.configuration?.program ? findProjectForFile(session.configuration.program) : undefined);
          if (projPath) {
            try {
              const parsed = parseProject(projPath);
              if (parsed && parsed.targetFramework && /^net4/i.test(parsed.targetFramework)) {
                isFramework = true;
              }
            } catch {
              // ignore parse errors and fall back to default
            }
          }
        }

        const adapter = resolveSharpDbgAdapter(isFramework, session.configuration);
        if (!adapter) {
          // Offer to install SharpDbg from the Marketplace.
          await promptInstallSharpDbg(context);
          throw new Error('SharpDbg extension (lextudio.sharpdbg) is required for WPF debugging.');
        }
        const options: vscode.DebugAdapterExecutableOptions = {} as any;
        if (adapter.cwd) {
          options.cwd = adapter.cwd;
        }
        if (adapter.env) {
          options.env = adapter.env;
        }
        return new vscode.DebugAdapterExecutable(adapter.command, adapter.args, options);
      },
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
        uri?.scheme === 'file' && isSupportedProjectPath(uri.fsPath)
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
        selectedProjects.set(getWorkspaceFolderKey(picked.detail), projectPath);
        await vscode.window.showTextDocument(document, { preview: false });
        updateStatusBar(vscode.window.activeTextEditor, projectPath);
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

  // -------------------------------------------------------------------------
  // Command: wpf.addEnableWindowsTargeting
  // Adds <EnableWindowsTargeting>true</EnableWindowsTargeting> to a csproj
  // on non-Windows hosts when the language server detects it's missing.
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('wpf.addEnableWindowsTargeting', async (projectPath?: string) => {
      if (!projectPath) {
        vscode.window.showWarningMessage('No project path provided to add EnableWindowsTargeting.');
        return;
      }

      try {
        const cfg = vscode.workspace.getConfiguration('wpf');
        const autoApply = cfg.get<boolean>('autoEnableWindowsTargeting', false);

        // Prefer the analyzer CLI to apply the change so the extension does
        // not manipulate XML directly. Resolve the analyzer binary first.
        const analyzerExe = resolveAnalyzerExecutable(context);
        if (!analyzerExe) {
          vscode.window.showWarningMessage('WPF Project Analyzer binary not found. Build the extension tools first.');
          return;
        }

        // Quick check: query the analyzer to see if the project already has the
        // property (XML fallback will reliably detect an explicit setting).
        const current = await runProjectAnalyzer(analyzerExe, projectPath);
        if (current?.enableWindowsTargeting === true || current?.windowsTargetingStatus === 'enabled') {
          vscode.window.showInformationMessage('EnableWindowsTargeting is already set in this project.');
          return;
        }

        // If not autoApply, prompt the user
        if (!autoApply) {
          const choice = await vscode.window.showWarningMessage(
            `The project ${path.basename(projectPath)} may require <EnableWindowsTargeting>true to build on this platform. Add it to the project file?`,
            'Add to csproj',
            'Open csproj',
            'Ignore'
          );

          if (choice === 'Open csproj') {
            const doc = await vscode.workspace.openTextDocument(projectPath);
            await vscode.window.showTextDocument(doc);
            return;
          }

          if (choice !== 'Add to csproj') {
            return; // user chose Ignore or dismissed
          }
        }

        // Run the analyzer in apply mode (shows a progress notification)
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Updating project...', cancellable: false }, async () => {
          const isDll = analyzerExe.endsWith('.dll');
          const cmd = isDll ? getPreferredDotnetPath() : analyzerExe;
          const args = isDll ? [analyzerExe, '--apply-enable-windows-targeting', projectPath] : ['--apply-enable-windows-targeting', projectPath];

          let stdout = '';
          let stderr = '';
          const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
          proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

          const code: number = await new Promise(resolve => proc.on('close', (c: number | null) => resolve(c ?? 0)));
          if (code === 0) {
            vscode.window.showInformationMessage('Added <EnableWindowsTargeting>true to project (backup saved).', 'Open file').then(async choice => {
              if (choice === 'Open file') {
                const opened = await vscode.workspace.openTextDocument(projectPath);
                await vscode.window.showTextDocument(opened);
              }
            });
          } else {
            const errMsg = stderr || stdout || 'Unknown error from analyzer';
            vscode.window.showErrorMessage(`Failed to update project file: ${errMsg}`);
          }
        });
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to update project file: ${String(err)}`);
      }
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
    vscode.commands.registerCommand('wpf._test.findProjectForFile', async (filePath?: string) => {
      if (!filePath) { return null; }
      return findProjectForFile(filePath);
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
      'wpf._test.pushRuntimeXamlUpdateDetailed',
      async (projectPath?: string, xamlPath?: string, xamlText?: string) => {
        if (!projectPath || !xamlPath || !xamlText) {
          return { success: false, message: 'missing arguments', degraded: false };
        }

        return pushRuntimeXamlUpdateDetailed(projectPath, xamlPath, xamlText);
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
      void updateWpfXamlContext(editor, context);
    })
  );


  // Initialise for the current editor (if any).
  {
    const editor = vscode.window.activeTextEditor;
    const project = editor ? getCachedProject(editor.document.uri.fsPath) : null;
    updateStatusBar(editor, project ?? null);
    void updateWpfXamlContext(editor, context);
  }

  // Invalidate the analyzer cache when project files change so that
  // button visibility is re-evaluated on the next editor switch.
  const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.{csproj,vbproj,fsproj}');
  const invalidateAnalyzerCache = (uri: vscode.Uri) => {
    analyzerCache.delete(uri.fsPath);
    // Re-evaluate for the current editor in case it was affected.
    void updateWpfXamlContext(vscode.window.activeTextEditor, context);
  };
  projectWatcher.onDidChange(invalidateAnalyzerCache);
  projectWatcher.onDidCreate(invalidateAnalyzerCache);
  projectWatcher.onDidDelete(invalidateAnalyzerCache);
  context.subscriptions.push(projectWatcher);

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

async function tryInsertEventHandlerViaLanguageServer(
  xamlPath: string,
  eventName: string,
  handlerName: string
): Promise<vscode.Position | null> {
  const client = getLanguageServerClient();
  if (!client) {
    logEventHandler('Language server client is unavailable.');
    return null;
  }

  const xamlUri = vscode.Uri.file(xamlPath);
  const xamlDoc = await vscode.workspace.openTextDocument(xamlUri);
  const attributeRange = findEventHandlerAttributeRange(xamlDoc, eventName, handlerName);
  if (!attributeRange) {
    logEventHandler(`Attribute range not found for ${eventName}='${handlerName}' in ${xamlPath}`);
    return null;
  }
  logEventHandler(
    `Resolved attribute range ${attributeRange.start.line + 1}:${attributeRange.start.character + 1}` +
    `-${attributeRange.end.line + 1}:${attributeRange.end.character + 1}`
  );

  const actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
    'vscode.executeCodeActionProvider',
    xamlUri,
    attributeRange
  );

  if (!actions?.length) {
    logEventHandler('No code actions returned by vscode.executeCodeActionProvider.');
    return null;
  }
  logEventHandler(`Code actions returned: ${actions.length}`);

  const chosen = chooseEventHandlerAction(actions, handlerName);
  if (!chosen) {
    const titles = actions
      .filter((action): action is vscode.CodeAction => 'title' in action)
      .map(action => action.title)
      .join(' | ');
    logEventHandler(`No matching event-handler code action. Titles: ${titles || '(none)'}`);
    return null;
  }
  logEventHandler(`Chosen action: ${chosen.title}`);

  if ('edit' in chosen && chosen.edit) {
    logEventHandler('Applying workspace edit from chosen action.');
    const editApplied = await vscode.workspace.applyEdit(chosen.edit);
    if (!editApplied) {
      logEventHandler('workspace.applyEdit returned false.');
      return null;
    }
  }

  if ('command' in chosen && chosen.command) {
    logEventHandler(`Executing action command: ${chosen.command.command}`);
    await vscode.commands.executeCommand(
      chosen.command.command,
      ...(chosen.command.arguments ?? [])
    );
  }

  const codeBehindPath = resolveCodeBehindPath(xamlPath);
  if (!codeBehindPath) {
    logEventHandler(`No code-behind file found after applying action for ${xamlPath}.`);
    return null;
  }

  const codeBehindUri = vscode.Uri.file(codeBehindPath);
  const codeBehindDoc = await vscode.workspace.openTextDocument(codeBehindUri);
  const methodMatch = new RegExp(`\\b${escapeRegExp(handlerName)}\\s*\\(`).exec(codeBehindDoc.getText());
  if (!methodMatch) {
    logEventHandler(`Handler method '${handlerName}' not found after action application.`);
    return null;
  }
  logEventHandler(`Handler method '${handlerName}' located in ${codeBehindUri.fsPath}.`);

  return codeBehindDoc.positionAt(methodMatch.index);
}

async function tryInsertEventHandlerFallback(
  codeBehindPath: string,
  codeBehindLanguage: CodeBehindLanguage,
  handlerName: string,
  eventArgTypeFullName: string
): Promise<vscode.Position | null> {
  try {
    const uri = vscode.Uri.file(codeBehindPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const content = doc.getText();

    const existingMethod = codeBehindLanguage === 'vb'
      ? new RegExp(`\\b(?:Sub|Function)\\s+${escapeRegExp(handlerName)}\\s*\\(`, 'i').exec(content)
      : codeBehindLanguage === 'fsharp'
        ? new RegExp(`\\bmember\\s+(?:this|_)\\.${escapeRegExp(handlerName)}\\s*\\(`).exec(content)
        : new RegExp(`\\bvoid\\s+${escapeRegExp(handlerName)}\\s*\\(`).exec(content);
    if (existingMethod) {
      logEventHandler(`Fallback: handler '${handlerName}' already exists.`);
      return doc.positionAt(existingMethod.index);
    }

    const insertionOffset = codeBehindLanguage === 'vb'
      ? findVbClassInsertionOffset(content)
      : codeBehindLanguage === 'fsharp'
        ? findFSharpMemberInsertionOffset(content)
        : findClassClosingBraceOffset(content);
    if (insertionOffset < 0) {
      logEventHandler('Fallback: could not find class insertion point.');
      return null;
    }

    const indent = detectIndent(content);
    const memberIndent = indent + indent;
    const argType = shortTypeName(eventArgTypeFullName);
    const stub = codeBehindLanguage === 'vb'
      ? `\n${memberIndent}Private Sub ${handlerName}(sender As Object, e As ${argType})\n${memberIndent}End Sub\n`
      : codeBehindLanguage === 'fsharp'
        ? `\n${memberIndent}member this.${handlerName}(sender: obj, e: ${argType}) = ()\n`
        : `\n${memberIndent}private void ${handlerName}(object sender, ${argType} e)\n${memberIndent}{\n${memberIndent + indent}\n${memberIndent}}\n`;

    const insertionPosition = doc.positionAt(insertionOffset);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, insertionPosition, stub);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      logEventHandler('Fallback: workspace.applyEdit returned false.');
      return null;
    }

    const updatedDoc = await vscode.workspace.openTextDocument(uri);
    const insertedMethod = new RegExp(`\\b${escapeRegExp(handlerName)}\\s*\\(`).exec(updatedDoc.getText());
    if (!insertedMethod) {
      logEventHandler(`Fallback: inserted handler '${handlerName}' was not found after edit.`);
      return null;
    }

    logEventHandler(`Fallback insertion succeeded for handler '${handlerName}'.`);
    return updatedDoc.positionAt(insertedMethod.index);
  } catch (err) {
    logEventHandler(`Fallback insertion threw: ${String(err)}`);
    return null;
  }
}

function chooseEventHandlerAction(
  actions: Array<vscode.CodeAction | vscode.Command>,
  handlerName: string
): vscode.CodeAction | null {
  const normalizedHandler = handlerName.trim().toLowerCase();
  const codeActions = actions.filter((action): action is vscode.CodeAction => 'kind' in action);

  const preferred = codeActions.find(action => {
    const title = action.title.trim().toLowerCase();
    return title.includes('event handler') && title.includes(normalizedHandler);
  });
  if (preferred) {
    return preferred;
  }

  // Fallback: older/newer title variants from the AXSG provider.
  return codeActions.find(action => {
    const title = action.title.trim().toLowerCase();
    return title.startsWith('axsg: add') && title.includes(normalizedHandler);
  }) ?? null;
}

function findEventHandlerAttributeRange(
  document: vscode.TextDocument,
  eventName: string,
  handlerName: string
): vscode.Range | null {
  const text = document.getText();
  const exactPattern = new RegExp(
    `\\b${escapeRegExp(eventName)}\\s*=\\s*(['"])${escapeRegExp(handlerName)}\\1`,
    'g'
  );
  const exactMatch = exactPattern.exec(text);
  if (exactMatch && exactMatch.index >= 0) {
    const start = document.positionAt(exactMatch.index);
    const end = document.positionAt(exactMatch.index + exactMatch[0].length);
    return new vscode.Range(start, end);
  }

  // Fallback when the designer callback arrives before the exact handler value
  // is persisted in XAML: target the first matching event attribute by name.
  const eventOnlyPattern = new RegExp(
    `\\b${escapeRegExp(eventName)}\\s*=\\s*(['"])[^'"]*\\1`,
    'g'
  );
  const eventOnlyMatch = eventOnlyPattern.exec(text);
  if (eventOnlyMatch && eventOnlyMatch.index >= 0) {
    const start = document.positionAt(eventOnlyMatch.index);
    const end = document.positionAt(eventOnlyMatch.index + eventOnlyMatch[0].length);
    return new vscode.Range(start, end);
  }

  // Last resort: ask for actions at document start so provider-side diagnostics
  // can still surface a relevant event-handler fix.
  return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortTypeName(fullName: string): string {
  return fullName.split('.').pop() ?? 'EventArgs';
}

function detectIndent(content: string): string {
  const match = /^([ \t]+)\S/m.exec(content);
  if (!match) {
    return '    ';
  }

  return match[1][0] === '\t' ? '\t' : '    ';
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isKeywordAt(content: string, index: number, keyword: string): boolean {
  if (!content.startsWith(keyword, index)) {
    return false;
  }

  const before = index > 0 ? content[index - 1] : '';
  const afterIndex = index + keyword.length;
  const after = afterIndex < content.length ? content[afterIndex] : '';
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

function findClassClosingBraceOffset(content: string): number {
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let inVerbatimString = false;
  let inChar = false;
  let classBodyStart = -1;
  let classDepth = 0;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = i + 1 < content.length ? content[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (inVerbatimString) {
        if (ch === '"' && next === '"') {
          i++;
          continue;
        }
        if (ch === '"') {
          inString = false;
          inVerbatimString = false;
        }
      } else {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
      }
      continue;
    }

    if (inChar) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '\'') {
        inChar = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === '@' && next === '"') {
      inString = true;
      inVerbatimString = true;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      inVerbatimString = false;
      continue;
    }

    if (ch === '\'') {
      inChar = true;
      continue;
    }

    if (classBodyStart < 0) {
      if (isKeywordAt(content, i, 'class')) {
        let j = i + 'class'.length;
        while (j < content.length) {
          const cj = content[j];
          const nj = j + 1 < content.length ? content[j + 1] : '';

          if (cj === '/' && nj === '/') {
            while (j < content.length && content[j] !== '\n') {
              j++;
            }
            continue;
          }

          if (cj === '/' && nj === '*') {
            j += 2;
            while (j + 1 < content.length && !(content[j] === '*' && content[j + 1] === '/')) {
              j++;
            }
            j++;
            continue;
          }

          if (cj === '{') {
            classBodyStart = j;
            classDepth = 1;
            i = j;
            break;
          }

          if (cj === ';') {
            break;
          }

          j++;
        }
      }
      continue;
    }

    if (ch === '{') {
      classDepth++;
      continue;
    }

    if (ch === '}') {
      classDepth--;
      if (classDepth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function findVbClassInsertionOffset(content: string): number {
  const endClassRegex = /^\s*End\s+Class\s*$/gim;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | null = null;
  while ((match = endClassRegex.exec(content)) !== null) {
    lastMatch = match;
  }

  return lastMatch ? lastMatch.index : -1;
}

function findFSharpMemberInsertionOffset(content: string): number {
  // Find the offset after the last `member` definition in the F# type body.
  // We look for lines starting with optional whitespace followed by `member`.
  const memberRegex = /^[ \t]+member\b[^\n]*/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = memberRegex.exec(content)) !== null) {
    lastMatch = match;
  }

  if (lastMatch) {
    // Return the offset right after the matched member line (after its newline).
    const afterMember = lastMatch.index + lastMatch[0].length;
    return afterMember;
  }

  // No member found — fall back to end of file.
  return content.trimEnd().length;
}

function resolveCodeBehindPath(xamlPath: string): string | null {
  const csharpPath = xamlPath.replace(/\.xaml$/i, '.xaml.cs');
  if (fs.existsSync(csharpPath)) {
    return csharpPath;
  }

  const vbPath = xamlPath.replace(/\.xaml$/i, '.xaml.vb');
  if (fs.existsSync(vbPath)) {
    return vbPath;
  }

  const fsharpPath = xamlPath.replace(/\.xaml$/i, '.xaml.fs');
  if (fs.existsSync(fsharpPath)) {
    return fsharpPath;
  }

  return null;
}

function getCodeBehindLanguage(codeBehindPath: string): CodeBehindLanguage {
  const lower = codeBehindPath.toLowerCase();
  if (lower.endsWith('.xaml.vb')) {
    return 'vb';
  }

  if (lower.endsWith('.xaml.fs')) {
    return 'fsharp';
  }

  return 'csharp';
}

function isSupportedProjectPath(projectPath: string): boolean {
  const lower = projectPath.toLowerCase();
  return lower.endsWith('.csproj') || lower.endsWith('.vbproj') || lower.endsWith('.fsproj');
}

// ---------------------------------------------------------------------------
// Windows targeting check via WpfProjectAnalyzer CLI tool
// ---------------------------------------------------------------------------

interface ProjectAnalysisResult {
  projectPath: string;
  isWpfProject?: boolean;
  windowsTargetingStatus?: string;
  enableWindowsTargeting?: boolean;
  isWpfProject?: boolean;
}

/**
 * Resolves the path to the `wpf-project-analyzer` binary published under
 * `tools/WpfProjectAnalyzer/` in the extension directory.
 * Returns null if the binary hasn't been built yet.
 */
function resolveAnalyzerExecutable(context: vscode.ExtensionContext): string | null {
  const toolsDir = path.join(context.extensionPath, 'tools', 'WpfProjectAnalyzer');
  for (const name of ['wpf-project-analyzer.exe', 'wpf-project-analyzer.dll']) {
    const candidate = path.join(toolsDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Runs `wpf-project-analyzer <projectPath>` and returns the parsed JSON result,
 * or null if the tool fails or produces unexpected output.
 */
function runProjectAnalyzer(
  analyzerExe: string,
  projectPath: string,
): Promise<ProjectAnalysisResult | null> {
  return new Promise(resolve => {
    const isDll = analyzerExe.endsWith('.dll');
    const cmd = isDll ? getPreferredDotnetPath() : analyzerExe;
    const args = isDll ? [analyzerExe, projectPath] : [projectPath];

    let stdout = '';
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code: number | null) => {
      if (code !== 0 && code !== null) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ProjectAnalysisResult);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * On non-Windows hosts, scans all WPF projects in the workspace and prompts
 * the user to add `<EnableWindowsTargeting>true</EnableWindowsTargeting>` to
 * any project that requires it.
 */
async function checkWindowsTargetingForWorkspace(context: vscode.ExtensionContext): Promise<void> {
  if (process.platform === 'win32') {
    return; // Windows already started the server in activate()
  }

  const analyzerExe = resolveAnalyzerExecutable(context);
  if (!analyzerExe) {
    // Analyzer binary not built yet — start the server without checks.
    startLanguageServer(context);
    return;
  }

  let projects: string[];
  try {
    projects = await findProjectsInWorkspace();
  } catch {
    startLanguageServer(context);
    return;
  }

  if (!projects || projects.length === 0) {
    console.log('WPF extension: no projects found; language server will not start.');
    return;
  }

  // Run the analyzer on all projects. The analyzer determines which are WPF.
  const results = await Promise.all(
    projects.map(async p => ({ projectPath: p, result: await runProjectAnalyzer(analyzerExe, p) }))
  );

  // Filter to WPF projects confirmed by the analyzer.
  const wpfProjects = results.filter(r => r.result?.isWpfProject === true);
  if (wpfProjects.length === 0) {
    console.log('WPF extension: analyzer detected no WPF projects; language server will not start.');
    return;
  }

  // If any project is a legacy (non-SDK) .NET Framework WPF project the
  // language server cannot provide XAML tooling on macOS/Linux — bail out.
  const legacyProjects = wpfProjects.filter(r => r.result?.windowsTargetingStatus === 'legacy_wpf');
  if (legacyProjects.length > 0) {
    void vscode.window.showWarningMessage(
      'Legacy .NET Framework WPF projects are not supported on macOS/Linux. ' +
      'The XAML language server will not start. Migrate to an SDK-style project to enable tooling.'
    );
    return;
  }

  // For SDK-style projects missing EnableWindowsTargeting, prompt the user
  // and apply the change — await each so the project file is updated before
  // the language server loads.
  const requiredProjects = wpfProjects.filter(r => r.result?.windowsTargetingStatus === 'required');
  for (const { projectPath } of requiredProjects) {
    await vscode.commands.executeCommand('wpf.addEnableWindowsTargeting', projectPath);
  }

  // All WPF projects are either already compatible or have just been updated.
  startLanguageServer(context);
}

export async function deactivate(): Promise<void> {
  for (const timer of hotReloadTimers.values()) {
    clearTimeout(timer);
  }
  hotReloadTimers.clear();
  await stopLanguageServer();
  eventHandlerLogChannel?.dispose();
  eventHandlerLogChannel = undefined;
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

async function resolveProjectForAction(
  resource: vscode.Uri,
  allowPrompt = true
): Promise<string | null> {
  const xamlPath = resource.fsPath;
  const folderKey = getWorkspaceFolderKey(xamlPath);

  const cached = selectedProjects.get(folderKey);
  if (cached) {
    return cached;
  }

  const detected = await findProjectForFile(xamlPath);
  if (detected) {
    selectedProjects.set(folderKey, detected);
    updateStatusBar(vscode.window.activeTextEditor, detected);
    return detected;
  }

  const designerContext = await getDesignerProjectContext(resource);
  if (designerContext?.projectPath) {
    selectedProjects.set(folderKey, designerContext.projectPath);
    updateStatusBar(vscode.window.activeTextEditor, designerContext.projectPath);
    return designerContext.projectPath;
  }

  if (!allowPrompt) {
    return null;
  }

  return resolveProject(xamlPath);
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

// Cache for wpf-project-analyzer results: project file path -> isWpfProject.
const analyzerCache = new Map<string, boolean>();

/**
 * Walk up from a file's directory to the workspace root looking for the
 * nearest project file (.csproj/.vbproj/.fsproj).  Unlike findProjectForFile,
 * this does NOT filter by isWpfProject — it returns any project file.
 */
function findNearestProjectFile(filePath: string): string | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const roots = workspaceFolders ? workspaceFolders.map(f => f.uri.fsPath) : [];
  const projectExtensions = ['.csproj', '.vbproj', '.fsproj'];

  let dir = path.dirname(filePath);
  while (true) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (projectExtensions.includes(path.extname(entry).toLowerCase())) {
          return path.join(dir, entry);
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
 * Set the `wpf.isWpfXaml` context so that editor title buttons are hidden
 * for non-WPF XAML files (e.g. WinUI 3, Avalonia, UWP, Uno).
 *
 * Uses the wpf-project-analyzer CLI tool for reliable MSBuild-based detection
 * rather than simple heuristics.  Results are cached per project file path.
 */
async function updateWpfXamlContext(
  editor: vscode.TextEditor | undefined,
  extensionContext: vscode.ExtensionContext,
): Promise<void> {
  if (!editor ||
      editor.document.uri.scheme !== 'file' ||
      editor.document.languageId !== 'xaml') {
    void vscode.commands.executeCommand('setContext', 'wpf.isWpfXaml', false);
    return;
  }

  const projectFile = findNearestProjectFile(editor.document.uri.fsPath);
  if (!projectFile) {
    void vscode.commands.executeCommand('setContext', 'wpf.isWpfXaml', false);
    return;
  }

  const cached = analyzerCache.get(projectFile);
  if (cached !== undefined) {
    void vscode.commands.executeCommand('setContext', 'wpf.isWpfXaml', cached);
    return;
  }

  const analyzerExe = resolveAnalyzerExecutable(extensionContext);
  if (!analyzerExe) {
    // Analyzer binary not available — default to showing buttons so WPF users
    // are not penalised.
    void vscode.commands.executeCommand('setContext', 'wpf.isWpfXaml', true);
    return;
  }

  const result = await runProjectAnalyzer(analyzerExe, projectFile);
  const isWpf = result?.isWpfProject ?? false;
  analyzerCache.set(projectFile, isWpf);
  void vscode.commands.executeCommand('setContext', 'wpf.isWpfXaml', isWpf);
}

function getAutoBuildOnDesignerLaunch(configuration: vscode.WorkspaceConfiguration): boolean {
  const explicit = configuration.get<boolean | undefined>('autoBuildOnDesignerLaunch');
  if (typeof explicit === 'boolean') {
    return explicit;
  }

  return configuration.get<boolean>('autoBuildOnPreview', true);
}

async function scheduleHotReload(document: vscode.TextDocument): Promise<void> {
  if (document.uri.scheme !== 'file' || document.languageId !== 'xaml') {
    return;
  }

  if (!isWpfXaml(document.uri.fsPath)) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('wpf');
  const designerSyncOnEdit = cfg.get<boolean>('designerSyncOnEdit', true);
  if (!designerSyncOnEdit) {
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
  const projectPath = await resolveProjectForAction(resource, false);
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

/**
 * Recommend XAMLStyler extension for XAML formatting.
 */
async function recommendXamlStyler(context: vscode.ExtensionContext): Promise<void> {
  try {
    const stylerId = 'dabbinavo.xamlstyler';
    const suppressKey = 'wpf.suppressXamlStylerRecommendation';

    const isSuppressed = context.globalState.get<boolean>(suppressKey, false);
    const isInstalled = vscode.extensions.getExtension(stylerId);

    if (!isSuppressed && !isInstalled) {
      const choice = await vscode.window.showInformationMessage(
        'For formatting XAML you can optionally install "XAML Styler". Would you like to view it?',
        'Show Extension',
        "Don't Show Again"
      );

      if (choice === 'Show Extension') {
        await vscode.commands.executeCommand('workbench.extensions.search', stylerId);
      } else if (choice === "Don't Show Again") {
        await context.globalState.update(suppressKey, true);
      }
    }
  } catch (e) {
    console.error(`Failed recommending XAML Styler: ${e}`);
  }
}




import * as vscode from 'vscode';
import * as path from 'path';
import { isCSharpDevKitInstalled } from './projectDiscovery';

let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Create (once) and return the WPF status bar item.
 */
export function getStatusBarItem(): vscode.StatusBarItem {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'wpf.selectProject';
    statusBarItem.tooltip = 'WPF project context for Hot Reload and designer actions — click to change';
  }
  return statusBarItem;
}

/**
 * Refresh the status bar based on the active editor and currently selected project.
 * Hidden when C# Dev Kit is installed and a project has been auto-detected
 * (C# Dev Kit already provides a solution/project indicator).
 */
export function updateStatusBar(
  activeEditor: vscode.TextEditor | undefined,
  selectedProject: string | null
): void {
  const item = getStatusBarItem();

  if (!activeEditor || activeEditor.document.languageId !== 'xaml') {
    item.hide();
    return;
  }

  if (selectedProject) {
    const name = path.basename(selectedProject, '.csproj');
    item.text = `$(tools) WPF: ${name}`;

    // Suppress our own indicator when C# Dev Kit is managing project context
    // and the project was discovered automatically (not user-selected).
    if (isCSharpDevKitInstalled()) {
      item.hide();
      return;
    }
  } else {
    item.text = `$(tools) WPF: (no project)`;
  }

  item.show();
}

export function disposeStatusBar(): void {
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

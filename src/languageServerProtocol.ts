import * as vscode from 'vscode';
import {
  LanguageClient,
} from 'vscode-languageclient/node';

export interface PreviewProjectContext {
  projectPath: string;
  projectDirectory: string;
  filePath: string;
  targetPath: string;
}

export async function requestPreviewProjectContext(
  client: LanguageClient | undefined,
  documentUri: vscode.Uri
): Promise<PreviewProjectContext | null> {
  if (!client) {
    return null;
  }

  const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? null;

  try {
    const result = await client.sendRequest<PreviewProjectContext | null>(
      'axsg/preview/projectContext',
      {
        textDocument: { uri: documentUri.toString() },
        workspaceRoot,
      }
    );
    return result;
  } catch {
    return null;
  }
}

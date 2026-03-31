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

export interface DocumentPosition {
  line: number;
  character: number;
}

export interface DocumentRange {
  start: DocumentPosition;
  end: DocumentPosition;
}

export interface HotReloadMapDocumentResult {
  uri?: string;
  range?: DocumentRange;
  confidence?: number;
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

export async function requestHotReloadMapDocument(
  client: LanguageClient | undefined,
  documentUri: vscode.Uri,
  elementName: string,
  typeName: string
): Promise<HotReloadMapDocumentResult | null> {
  if (!client) {
    return null;
  }

  const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? null;

  try {
    const result = await client.sendRequest<HotReloadMapDocumentResult | null>(
      'axsg/hotreload/mapDocument',
      {
        textDocument: { uri: documentUri.toString() },
        workspaceRoot,
        runtimeElement: {
          name: elementName,
          typeName,
        },
      }
    );

    return result;
  } catch {
    return null;
  }
}

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('VS Code WPF extension is now active.');

  const preview = vscode.commands.registerCommand('wpf.previewXaml', (uri: vscode.Uri | undefined) => {
    const editor = vscode.window.activeTextEditor;
    const resource = uri ?? editor?.document?.uri;
    const name = resource ? resource.fsPath.split(/[\\/]/).pop() : 'current file';
    vscode.window.showInformationMessage(`Preview (placeholder) for ${name}`);
  });
  context.subscriptions.push(preview);
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file', language: 'xaml' },
    {
      provideHover(document: vscode.TextDocument, position: vscode.Position) {
        const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9_.:-]+/);
        const word = range ? document.getText(range) : '';
        if (!word) {
          return undefined;
        }
        return new vscode.Hover(`XAML symbol: ${word}`);
      }
    }
  );
  context.subscriptions.push(hoverProvider);
}

export function deactivate() {}

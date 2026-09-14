import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { repoRoot } from './paths';

const sampleProjectPath = path.join(repoRoot, 'sample', 'net6.0', 'sample.csproj');
const mainWindowPath = path.join(repoRoot, 'sample', 'net6.0', 'MainWindow.xaml');

export async function run(): Promise<void> {
  console.log('Running WPF XAML language server integration smoke test.');

  await activateExtension();

  await vscode.commands.executeCommand('wpf._test.setProject', {
    filePath: mainWindowPath,
    projectPath: sampleProjectPath,
  });

  const document = await vscode.workspace.openTextDocument(mainWindowPath);
  await vscode.window.showTextDocument(document, { preview: false });

  // Tier-1 (WpfCore) sanity check: completions on the bare <Grid> element should be
  // available almost immediately, without waiting for the MSBuild-backed compilation.
  const gridLine = findLineContaining(document, '<Grid>');
  const gridAttributePosition = new vscode.Position(gridLine, document.lineAt(gridLine).text.indexOf('<Grid>') + '<Grid'.length);
  const tier1Completions = await waitForCompletions(document.uri, gridAttributePosition, 20_000);
  assert.ok(
    tier1Completions.items.some(item => typeof item.label === 'string' ? item.label === 'Width' : item.label.label === 'Width'),
    'Expected Tier-1 WPF-core completions (e.g. "Width") on <Grid>.'
  );

  // Tier-2 (full MSBuild compilation) sanity check: the user-defined local:SamplePane
  // control resolved via clr-namespace should not produce an "unresolved type" diagnostic
  // once the background prewarm completes and diagnostics are (eventually) refreshed.
  await waitForNoErrorDiagnostics(document.uri, 120_000);

  console.log('WPF XAML language server integration smoke test passed.');
}

async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension('lextudio.vscode-wpf');
  assert.ok(extension, 'Expected the vscode-wpf extension to be available in the test host.');
  await extension.activate();
}

function findLineContaining(document: vscode.TextDocument, needle: string): number {
  for (let line = 0; line < document.lineCount; line++) {
    if (document.lineAt(line).text.includes(needle)) {
      return line;
    }
  }
  throw new Error(`Could not find a line containing "${needle}" in ${document.uri.fsPath}.`);
}

async function waitForCompletions(
  uri: vscode.Uri,
  position: vscode.Position,
  timeoutMs: number
): Promise<vscode.CompletionList> {
  const start = Date.now();
  let lastList: vscode.CompletionList | undefined;
  while (Date.now() - start < timeoutMs) {
    lastList = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      position
    );
    if (lastList && lastList.items.length > 0) {
      return lastList;
    }
    await delay(500);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for non-empty completions at ${uri.fsPath}:${position.line}:${position.character}. ` +
      `Last result: ${lastList ? lastList.items.length : 'undefined'} items.`
  );
}

async function waitForNoErrorDiagnostics(uri: vscode.Uri, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErrors: vscode.Diagnostic[] = [];
  while (Date.now() - start < timeoutMs) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    lastErrors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    if (lastErrors.length === 0) {
      return;
    }
    await delay(1000);
  }
  const messages = lastErrors.map(d => `  [${d.range.start.line}:${d.range.start.character}] ${d.message}`).join('\n');
  throw new Error(`Timed out after ${timeoutMs}ms waiting for error diagnostics to clear on ${uri.fsPath}:\n${messages}`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

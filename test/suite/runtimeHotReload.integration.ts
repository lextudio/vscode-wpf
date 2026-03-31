import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

type RuntimeSessionInfo = {
  projectPath: string;
  xamlPath: string | null;
  pipeName: string | null;
  debugSessionId: string;
};

type PipeResponse = {
  result?: string;
  value?: string | null;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const sampleProjectPath = path.join(repoRoot, 'sample', 'sample.csproj');
const mainWindowPath = path.join(repoRoot, 'sample', 'MainWindow.xaml');
const samplePanePath = path.join(repoRoot, 'sample', 'SamplePane.xaml');

export async function run(): Promise<void> {
  await vscode.window.showTextDocument(vscode.Uri.file(mainWindowPath));
  const document = await vscode.workspace.openTextDocument(mainWindowPath);
  const editor = await vscode.window.showTextDocument(document);
  const originalText = document.getText();
  const updatedText = originalText.replace('Background="Red"', 'Background="Green"');
  const paneDocument = await vscode.workspace.openTextDocument(samplePanePath);
  const paneEditor = await vscode.window.showTextDocument(paneDocument, { preview: false });
  const originalPaneText = paneDocument.getText();
  const updatedPaneText = originalPaneText.replace(
    'Text="Sample pane"',
    'Text="Sample pane updated by integration test"'
  ).replace(
    'Text="Nested control for hot reload smoke tests."',
    'Text="Nested control updated live by integration test."'
  );

  assert.notStrictEqual(updatedText, originalText, 'Expected MainWindow.xaml to contain a red button for the test.');
  assert.notStrictEqual(updatedPaneText, originalPaneText, 'Expected SamplePane.xaml to contain the original nested text for the test.');

  await vscode.commands.executeCommand('wpf._test.setProject', {
    filePath: mainWindowPath,
    projectPath: sampleProjectPath,
  });
  await vscode.commands.executeCommand('wpf._test.setProject', {
    filePath: samplePanePath,
    projectPath: sampleProjectPath,
  });

  try {
    await vscode.window.showTextDocument(editor.document, { preview: false });
    await vscode.commands.executeCommand('wpf.debugHotReload', editor.document.uri);

    const sessionInfo = await waitForRuntimeSession(sampleProjectPath);
    await waitForPipe(sessionInfo.pipeName);

    const initialBackground = await queryPipeValue(sessionInfo.pipeName, 'PrimaryButton.Background');
    assert.strictEqual(initialBackground, '#FFFF0000', `Expected initial button background to be red, got ${initialBackground ?? '(null)'}.`);
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'PaneTitle.Text'), 'Sample pane');
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'PaneBody.Text'), 'Nested control for hot reload smoke tests.');
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'PaneList.SelectedIndex'), '1');

    await editor.edit(editBuilder => {
      const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length)
      );
      editBuilder.replace(fullRange, updatedText);
    });
    await editor.document.save();

    await vscode.commands.executeCommand('wpf.debugHotReload', editor.document.uri);

    const updatedBackground = await waitForProbeValue(sessionInfo.pipeName, 'PrimaryButton.Background', '#FF008000');
    assert.strictEqual(updatedBackground, '#FF008000', `Expected hot reload to turn the button green, got ${updatedBackground ?? '(null)'}.`);

    await vscode.window.showTextDocument(paneEditor.document, { preview: false });
    await paneEditor.edit(editBuilder => {
      const fullRange = new vscode.Range(
        paneEditor.document.positionAt(0),
        paneEditor.document.positionAt(paneEditor.document.getText().length)
      );
      editBuilder.replace(fullRange, updatedPaneText);
    });
    await paneEditor.document.save();

    await vscode.commands.executeCommand('wpf.debugHotReload', paneEditor.document.uri);

    assert.strictEqual(
      await waitForProbeValue(sessionInfo.pipeName, 'PaneTitle.Text', 'Sample pane updated by integration test'),
      'Sample pane updated by integration test'
    );
    assert.strictEqual(
      await waitForProbeValue(sessionInfo.pipeName, 'PaneBody.Text', 'Nested control updated live by integration test.'),
      'Nested control updated live by integration test.'
    );
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'PaneList.SelectedIndex'), '1');
  } finally {
    const latestDocument = await vscode.workspace.openTextDocument(mainWindowPath);
    const latestEditor = await vscode.window.showTextDocument(latestDocument);
    await latestEditor.edit(editBuilder => {
      const fullRange = new vscode.Range(
        latestDocument.positionAt(0),
        latestDocument.positionAt(latestDocument.getText().length)
      );
      editBuilder.replace(fullRange, originalText);
    });
    await latestEditor.document.save();
    await fs.writeFile(mainWindowPath, originalText, 'utf8');

    const latestPaneDocument = await vscode.workspace.openTextDocument(samplePanePath);
    const latestPaneEditor = await vscode.window.showTextDocument(latestPaneDocument, { preview: false });
    await latestPaneEditor.edit(editBuilder => {
      const fullRange = new vscode.Range(
        latestPaneDocument.positionAt(0),
        latestPaneDocument.positionAt(latestPaneDocument.getText().length)
      );
      editBuilder.replace(fullRange, originalPaneText);
    });
    await latestPaneEditor.document.save();
    await fs.writeFile(samplePanePath, originalPaneText, 'utf8');

    await vscode.debug.stopDebugging();
  }
}

async function waitForRuntimeSession(projectPath: string): Promise<RuntimeSessionInfo> {
  return await poll(async () => {
    const sessionInfo = await vscode.commands.executeCommand<RuntimeSessionInfo | null>(
      'wpf._test.getRuntimeSessionInfo',
      projectPath
    );
    return sessionInfo?.pipeName ? sessionInfo : null;
  }, 30000, 'Timed out waiting for runtime hot reload session.');
}

async function waitForPipe(pipeName: string | null): Promise<void> {
  assert.ok(pipeName, 'Expected a named pipe for the runtime hot reload session.');
  await poll(async () => {
    try {
      await queryPipeValue(pipeName, 'PrimaryButton.Background');
      return true;
    } catch {
      return null;
    }
  }, 30000, `Timed out waiting for hot reload pipe ${pipeName}.`);
}

async function waitForProbeValue(pipeName: string | null, query: string, expectedValue: string): Promise<string | null> {
  assert.ok(pipeName, 'Expected a named pipe for the runtime hot reload session.');
  return await poll(async () => {
    const value = await queryPipeValue(pipeName, query);
    return value === expectedValue ? value : null;
  }, 30000, `Timed out waiting for probe ${query} to become ${expectedValue}.`);
}

async function queryPipeValue(pipeName: string | null, query: string): Promise<string | null> {
  assert.ok(pipeName, 'Expected a named pipe for the runtime hot reload session.');

  return await new Promise<string | null>((resolve, reject) => {
    const client = net.createConnection(`\\\\.\\pipe\\${pipeName}`, () => {
      client.write(`${JSON.stringify({ kind: 'query', query })}\n`);
    });

    let responseText = '';
    client.on('data', chunk => {
      responseText += chunk.toString();
    });

    client.on('end', () => {
      try {
        const response = JSON.parse(responseText.trim()) as PipeResponse;
        if (response.result && response.result.startsWith('error:')) {
          reject(new Error(response.result));
          return;
        }

        resolve(response.value ?? null);
      } catch (err) {
        reject(err);
      }
    });

    client.on('error', reject);
    client.setTimeout(10000, () => {
      client.destroy(new Error(`Timed out waiting for response from pipe ${pipeName}.`));
    });
  });
}

async function poll<T>(operation: () => Promise<T | null>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null) {
        return result;
      }
    } catch (err) {
      lastError = err;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(lastError ? `${timeoutMessage} Last error: ${String(lastError)}` : timeoutMessage);
}

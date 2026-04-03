import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

type RuntimeSessionInfo = {
  projectPath: string;
  xamlPath: string | null;
  pipeName: string | null;
  pid: number | null;
};

type PipeResponse = {
  result?: string;
  value?: string | null;
};

type RuntimePushResult = {
  success: boolean;
  message: string;
  degraded: boolean;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const sampleProjectPath = path.join(repoRoot, 'sample', 'net6.0', 'sample.csproj');
const mainWindowPath = path.join(repoRoot, 'sample', 'net6.0', 'MainWindow.xaml');
const samplePanePath = path.join(repoRoot, 'sample', 'net6.0', 'SamplePane.xaml');
const deletedTextBlockName = 'HotReloadTransientText';
const addedButtonName = 'HotReloadAddedButton';
const removedPrimaryButtonName = 'PrimaryButton';

export async function run(): Promise<void> {
  await vscode.window.showTextDocument(vscode.Uri.file(mainWindowPath));
  const document = await vscode.workspace.openTextDocument(mainWindowPath);
  const editor = await vscode.window.showTextDocument(document);
  const originalText = document.getText();
  const deleteTextBlockRegex = /\s*<TextBlock\s+x:Name="HotReloadTransientText">\s*<Run Text="TextBlock from hot reload"\s*\/>\s*<\/TextBlock>\s*/m;
  const textAfterTextBlockDeletion = originalText.replace(deleteTextBlockRegex, '\n');
  const addButtonRegex = /(\s*<local:SamplePane\b[\s\S]*?\/>)/m;
  const textAfterButtonInsertion = originalText.replace(
    addButtonRegex,
    `\n    <Button x:Name="${addedButtonName}" Content="Added by integration test" Width="180" Height="32" Margin="320,45,0,0" HorizontalAlignment="Left" VerticalAlignment="Top" />$1`
  );
  const deletePrimaryButtonRegex = /\s*<Button\s+x:Name="PrimaryButton"[\s\S]*?\/>\s*/m;
  let updatedText = originalText;
  let expectedBackgroundAfterUpdate = '#FF008000';
  if (originalText.includes('Background="Red"')) {
    updatedText = originalText.replace('Background="Red"', 'Background="Green"');
    expectedBackgroundAfterUpdate = '#FF008000';
  } else if (originalText.includes('Background="Yellow"')) {
    updatedText = originalText.replace('Background="Yellow"', 'Background="Green"');
    expectedBackgroundAfterUpdate = '#FF008000';
  } else if (originalText.includes('Background="Green"')) {
    updatedText = originalText.replace('Background="Green"', 'Background="Red"');
    expectedBackgroundAfterUpdate = '#FFFF0000';
  }
  const textAfterPrimaryButtonDeletion = updatedText.replace(deletePrimaryButtonRegex, '\n');
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

  assert.notStrictEqual(updatedText, originalText, 'Expected MainWindow.xaml to contain a replaceable PrimaryButton Background color for the test.');
  assert.notStrictEqual(textAfterTextBlockDeletion, originalText, 'Expected MainWindow.xaml to contain the test TextBlock that can be deleted.');
  assert.notStrictEqual(textAfterButtonInsertion, originalText, 'Expected MainWindow.xaml to allow inserting a new Button for structural hot reload test.');
  assert.notStrictEqual(textAfterPrimaryButtonDeletion, updatedText, 'Expected MainWindow.xaml to allow deleting PrimaryButton for structural hot reload test.');
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
    await vscode.commands.executeCommand('wpf.hotReload', editor.document.uri);

    const sessionInfo = await waitForRuntimeSession(sampleProjectPath);
    await vscode.commands.executeCommand('wpf.hotReload', editor.document.uri);
    await waitForPipe(sessionInfo.pipeName);

    const initialBackground = await queryPipeValue(sessionInfo.pipeName, 'PrimaryButton.Background');
    assert.ok(initialBackground, `Expected initial button background probe value, got ${initialBackground ?? '(null)'}.`);

    // Verify diagnostic infrastructure is active.
    const sourceInfoAvailable = await queryPipeValue(sessionInfo.pipeName, 'diagnostics.sourceInfo');
    assert.strictEqual(sourceInfoAvailable, '1', 'Expected VisualDiagnostics.GetXamlSourceInfo to be resolved (ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1).');

    assert.strictEqual(
      await queryPipeValue(sessionInfo.pipeName, `element.exists:${deletedTextBlockName}`),
      '1',
      'Expected hot reload deletion target TextBlock to exist before deletion.'
    );
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'PaneTitle.Text'), 'Sample pane');
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'PaneBody.Text'), 'Nested control for hot reload smoke tests.');
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'PaneList.SelectedIndex'), '1');

    const textBlockDeleteResult = await vscode.commands.executeCommand<RuntimePushResult>(
      'wpf._test.pushRuntimeXamlUpdateDetailed',
      sampleProjectPath,
      mainWindowPath,
      textAfterTextBlockDeletion
    );
    const deleteMessage = textBlockDeleteResult?.message ?? '';
    assert.strictEqual(
      textBlockDeleteResult?.success,
      true,
      `Expected hot reload to apply when deleting a TextBlock from MainWindow.xaml. Result: ${textBlockDeleteResult?.message ?? '(null)'}`
    );
    assert.strictEqual(
      textBlockDeleteResult?.degraded,
      false,
      `Expected structural delete to use full apply path, got degraded apply message: ${textBlockDeleteResult?.message ?? '(null)'}`
    );
    assert.ok(
      !deleteMessage.includes('full apply skipped'),
      `Expected no full-apply skip during deletion, got: ${deleteMessage}`
    );
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'agent.ready'), '1', 'Expected runtime pipe to stay alive after TextBlock deletion.');
    assert.strictEqual(
      await waitForProbeValue(sessionInfo.pipeName, `element.exists:${deletedTextBlockName}`, '0'),
      '0',
      'Expected deleted TextBlock to be removed from the live visual tree.'
    );

    const addButtonResult = await vscode.commands.executeCommand<RuntimePushResult>(
      'wpf._test.pushRuntimeXamlUpdateDetailed',
      sampleProjectPath,
      mainWindowPath,
      textAfterButtonInsertion
    );
    const addButtonMessage = addButtonResult?.message ?? '';
    assert.strictEqual(
      addButtonResult?.success,
      true,
      `Expected hot reload to apply when adding a Button to MainWindow.xaml. Result: ${addButtonMessage || '(null)'}`
    );
    assert.strictEqual(
      addButtonResult?.degraded,
      false,
      `Expected button insertion to use full apply path, got degraded apply message: ${addButtonMessage || '(null)'}`
    );
    assert.ok(
      !addButtonMessage.includes('full apply skipped'),
      `Expected no full-apply skip during button insertion, got: ${addButtonMessage}`
    );
    assert.strictEqual(
      await waitForProbeValue(sessionInfo.pipeName, `element.exists:${addedButtonName}`, '1'),
      '1',
      'Expected newly added Button to exist in the live visual tree.'
    );

    await editor.edit(editBuilder => {
      const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length)
      );
      editBuilder.replace(fullRange, updatedText);
    });
    await editor.document.save();

    await vscode.commands.executeCommand('wpf.hotReload', editor.document.uri);

    const updatedBackground = await waitForProbeValue(sessionInfo.pipeName, 'PrimaryButton.Background', expectedBackgroundAfterUpdate);
    assert.strictEqual(
      updatedBackground,
      expectedBackgroundAfterUpdate,
      `Expected hot reload to update the button background to ${expectedBackgroundAfterUpdate}, got ${updatedBackground ?? '(null)'}.`
    );

    await vscode.window.showTextDocument(paneEditor.document, { preview: false });
    await paneEditor.edit(editBuilder => {
      const fullRange = new vscode.Range(
        paneEditor.document.positionAt(0),
        paneEditor.document.positionAt(paneEditor.document.getText().length)
      );
      editBuilder.replace(fullRange, updatedPaneText);
    });
    await paneEditor.document.save();

    await vscode.commands.executeCommand('wpf.hotReload', paneEditor.document.uri);

    assert.strictEqual(
      await waitForProbeValue(sessionInfo.pipeName, 'PaneTitle.Text', 'Sample pane updated by integration test'),
      'Sample pane updated by integration test'
    );
    assert.strictEqual(
      await waitForProbeValue(sessionInfo.pipeName, 'PaneBody.Text', 'Nested control updated live by integration test.'),
      'Nested control updated live by integration test.'
    );
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'PaneList.SelectedIndex'), '1');

    const removePrimaryButtonResult = await vscode.commands.executeCommand<RuntimePushResult>(
      'wpf._test.pushRuntimeXamlUpdateDetailed',
      sampleProjectPath,
      mainWindowPath,
      textAfterPrimaryButtonDeletion
    );
    const removePrimaryButtonMessage = removePrimaryButtonResult?.message ?? '';
    assert.strictEqual(
      removePrimaryButtonResult?.success,
      true,
      `Expected hot reload to apply when removing PrimaryButton. Result: ${removePrimaryButtonMessage || '(null)'}`
    );
    assert.strictEqual(
      removePrimaryButtonResult?.degraded,
      false,
      `Expected removing PrimaryButton to use full apply path, got degraded apply message: ${removePrimaryButtonMessage || '(null)'}`
    );
    assert.ok(
      !removePrimaryButtonMessage.includes('app exited shortly after apply'),
      `Expected app to stay alive after removing PrimaryButton, got: ${removePrimaryButtonMessage}`
    );
    assert.strictEqual(await queryPipeValue(sessionInfo.pipeName, 'agent.ready'), '1');
    assert.strictEqual(
      await waitForProbeValue(sessionInfo.pipeName, `element.exists:${removedPrimaryButtonName}`, '0'),
      '0',
      'Expected removed PrimaryButton to be absent from the live visual tree.'
    );
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

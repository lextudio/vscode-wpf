import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { repoRoot } from './paths';

type DesignerSessionInfo = {
  projectPath: string;
  pipeName: string;
  pid: number | null;
  lastXamlPath: string | null;
};

const sampleProjectPath = path.join(repoRoot, 'sample', 'net6.0', 'sample.csproj');
const mainWindowPath = path.join(repoRoot, 'sample', 'net6.0', 'MainWindow.xaml');
const pipeText = 'TextBlock from designer integration test';

export async function run(): Promise<void> {
  console.log('Running LibreWPF designer integration smoke test.');

  if (process.platform === 'win32') {
    console.log('Skipping LibreWPF designer smoke test on Windows.');
    return;
  }

  await activateExtension();

  await vscode.commands.executeCommand('wpf._test.setProject', {
    filePath: mainWindowPath,
    projectPath: sampleProjectPath,
  });

  const document = await vscode.workspace.openTextDocument(mainWindowPath);
  await vscode.window.showTextDocument(document, { preview: false });

  try {
    await vscode.commands.executeCommand('wpf.launchDesigner', vscode.Uri.file(mainWindowPath));

    const session = await waitForDesignerSession(sampleProjectPath);
    assert.strictEqual(session.lastXamlPath, mainWindowPath);
    assert.ok(session.pid && session.pid > 0, `Expected designer process id, got ${session.pid}.`);

    await waitForPipe(session.pipeName);
    await new Promise(resolve => setTimeout(resolve, 3000));
    await sendDesignerUpdate(session.pipeName, await createUpdatedXamlText());

    const afterUpdate = await waitForDesignerSession(sampleProjectPath);
    assert.strictEqual(afterUpdate.pipeName, session.pipeName);
    assert.strictEqual(afterUpdate.lastXamlPath, mainWindowPath);
  } finally {
    await vscode.commands.executeCommand('wpf._test.stopDesignerSession', sampleProjectPath);
  }
}

async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension('lextudio.vscode-wpf');
  assert.ok(extension, 'Expected the vscode-wpf extension to be available in the test host.');
  await extension.activate();
}

async function createUpdatedXamlText(): Promise<string> {
  const originalText = await fs.readFile(mainWindowPath, 'utf8');
  const updatedText = originalText.replace(/TextBlock from [^"]+/, pipeText);
  assert.notStrictEqual(
    updatedText,
    originalText,
    'Expected MainWindow.xaml to contain a replaceable TextBlock text value.'
  );
  return updatedText;
}

async function waitForDesignerSession(projectPath: string): Promise<DesignerSessionInfo> {
  return await poll(async () => {
    const sessionInfo = await vscode.commands.executeCommand<DesignerSessionInfo | null>(
      'wpf._test.getDesignerSessionInfo',
      projectPath
    );
    return sessionInfo?.pipeName ? sessionInfo : null;
  }, 30000, 'Timed out waiting for designer session.');
}

async function waitForPipe(pipeName: string): Promise<void> {
  const pipePath = getDesignerPipePath(pipeName);
  await poll(async () => {
    try {
      await fs.stat(pipePath);
      return true;
    } catch {
      return null;
    }
  }, 30000, `Timed out waiting for designer pipe ${pipePath}.`);
}

async function sendDesignerUpdate(pipeName: string, xamlText: string): Promise<void> {
  const pipePath = getDesignerPipePath(pipeName);
  const payload = JSON.stringify({
    command: 'applyXamlText',
    path: mainWindowPath,
    xamlText,
  });

  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection(pipePath, () => {
      client.end(payload);
    });

    client.on('close', hadError => {
      if (!hadError) {
        resolve();
      }
    });
    client.on('error', reject);
    client.setTimeout(30000, () => {
      client.destroy(new Error(`Timed out sending designer update to ${pipePath}.`));
    });
  });
}

function getDesignerPipePath(pipeName: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}`
    : path.join(os.tmpdir(), `CoreFxPipe_${pipeName}`);
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

import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import * as net from 'net';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const frameworkProjectPath = path.join(repoRoot, 'sample', 'net462', 'sample.csproj');
const mainWindowPath = path.join(repoRoot, 'sample', 'net6.0', 'MainWindow.xaml');

type RuntimeSessionInfo = {
  projectPath: string;
  xamlPath: string | null;
  pipeName: string | null;
  pid: number | null;
};

export async function run(): Promise<void> {
  // 1. Verify the extension can detect the legacy project as WPF.
  const isWpf = await vscode.commands.executeCommand<boolean>(
    'wpf._test.isWpfProject',
    frameworkProjectPath
  );
  assert.strictEqual(isWpf, true, 'Expected net462 sample to be detected as a WPF project.');

  // 2. Verify parseProject returns a .NET Framework TFM (not the net10.0-windows default).
  const projectInfo = await vscode.commands.executeCommand<{ targetFramework: string } | null>(
    'wpf._test.parseProject',
    frameworkProjectPath
  );
  assert.ok(projectInfo, 'Expected parseProject to return project info for the net462 sample.');
  assert.strictEqual(projectInfo.targetFramework, 'net462', `Expected TFM "net462", got "${projectInfo.targetFramework}".`);

  // 3. Wire the XAML file to the Framework project via the test helper.
  await vscode.commands.executeCommand('wpf._test.setProject', {
    filePath: mainWindowPath,
    projectPath: frameworkProjectPath,
  });

  // 4. Attempt runtime hot reload — should now work via AppDomainManager injection.
  const document = await vscode.workspace.openTextDocument(mainWindowPath);
  await vscode.window.showTextDocument(document);

  await vscode.commands.executeCommand('wpf.hotReload', document.uri);

  // The session should be created and running.
  const sessionInfo = await vscode.commands.executeCommand<RuntimeSessionInfo | null>(
    'wpf._test.getRuntimeSessionInfo',
    frameworkProjectPath
  );
  assert.ok(sessionInfo, 'Expected a runtime session for .NET Framework project.');
  assert.ok(sessionInfo.pipeName, 'Expected pipe name to be set.');
  assert.ok(sessionInfo.pid, 'Expected app to be running.');

  // 5. Wait for the pipe to be ready and query a value.
  const connected = await waitForPipeReady(sessionInfo.pipeName);
  assert.ok(connected, 'Expected to connect to hot reload pipe.');

  const bgColor = await queryPipeValue(sessionInfo.pipeName, 'PrimaryButton.Background');
  assert.ok(bgColor, 'Expected to query button background color.');

  // 6. Push a XAML update.
  const updatedXaml = document.getText().replace('Background="Red"', 'Background="Green"');
  const updated = await vscode.commands.executeCommand<boolean>(
    'wpf._test.pushRuntimeXamlUpdate',
    frameworkProjectPath,
    mainWindowPath,
    updatedXaml
  );
  assert.strictEqual(updated, true, 'Expected hot reload to apply successfully.');

  // 7. Verify the change took effect.
  const newBgColor = await waitForValue(sessionInfo.pipeName, 'PrimaryButton.Background', '#FF008000');
  assert.strictEqual(newBgColor, '#FF008000', 'Expected button background to turn green.');
}

async function waitForPipeReady(pipeName: string | null): Promise<boolean> {
  assert.ok(pipeName);
  for (let i = 0; i < 30; i++) {
    try {
      const val = await queryPipeValue(pipeName, 'PrimaryButton.Background');
      if (val) return true;
    } catch { }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function waitForValue(pipeName: string | null, query: string, expected: string): Promise<string | null> {
  assert.ok(pipeName);
  for (let i = 0; i < 30; i++) {
    const val = await queryPipeValue(pipeName, query);
    if (val === expected) return val;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

function queryPipeValue(pipeName: string | null, query: string): Promise<string | null> {
  assert.ok(pipeName);
  return new Promise<string | null>((resolve, reject) => {
    const client = net.createConnection(`\\\\.\\pipe\\${pipeName}`, () => {
      client.write(`${JSON.stringify({ kind: 'query', query })}\n`);
    });

    let responseText = '';
    client.on('data', chunk => {
      responseText += chunk.toString();
    });

    client.on('end', () => {
      try {
        const response = JSON.parse(responseText.trim()) as { result?: string; value?: string };
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
      client.destroy(new Error(`Pipe timeout for ${pipeName}`));
    });
  });
}

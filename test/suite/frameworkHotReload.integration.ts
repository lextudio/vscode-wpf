import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const frameworkProjectPath = path.join(repoRoot, 'sample', 'net462', 'sample.csproj');
const mainWindowPath = path.join(repoRoot, 'sample', 'net6.0', 'MainWindow.xaml');

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

  // 4. Attempt runtime hot reload — it should return false for .NET Framework.
  const document = await vscode.workspace.openTextDocument(mainWindowPath);
  await vscode.window.showTextDocument(document);

  await vscode.commands.executeCommand('wpf.hotReload', document.uri);

  // The session should NOT have been created for a Framework project.
  const sessionInfo = await vscode.commands.executeCommand<{ pipeName: string | null } | null>(
    'wpf._test.getRuntimeSessionInfo',
    frameworkProjectPath
  );
  assert.strictEqual(sessionInfo, null, 'Expected no runtime session for a .NET Framework project.');
}

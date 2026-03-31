const path = require('path');
const cp = require('child_process');
const { runTests } = require('@vscode/test-electron');

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const proc = cp.spawn(command, args, {
      cwd: path.resolve(__dirname, '..'),
      shell: true,
      stdio: 'inherit',
    });

    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

async function killProcessByImage(imageName) {
  try {
    await runCommand('taskkill', ['/F', '/IM', imageName]);
  } catch {
    // It's fine if the process was not running.
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const extensionDevelopmentPath = repoRoot;
  const extensionTestsPath = path.join(repoRoot, 'out', 'test', 'suite', 'index.js');
  const sampleProject = path.join(repoRoot, 'sample', 'net6.0', 'sample.csproj');
  const frameworkSampleProject = path.join(repoRoot, 'sample', 'net462', 'sample.csproj');
  const sharpDbgProject = path.join(repoRoot, 'external', 'SharpDbg', 'src', 'SharpDbg.Cli', 'SharpDbg.Cli.csproj');
  const localVsCodeExecutablePath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');

  await killProcessByImage('sample.exe');
  await killProcessByImage('SharpDbg.Cli.exe');

  await runCommand('dotnet', ['build', sharpDbgProject, '--configuration', 'Debug', '-nologo']);
  await runCommand('dotnet', ['build', sampleProject, '--configuration', 'Debug', '-nologo']);
  await runCommand('msbuild', [frameworkSampleProject, '/p:Configuration=Debug', '/nologo', '/v:m']);

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath: localVsCodeExecutablePath,
    });
  } finally {
    await killProcessByImage('sample.exe');
    await killProcessByImage('SharpDbg.Cli.exe');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

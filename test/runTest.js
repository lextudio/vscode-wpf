const path = require('path');
const cp = require('child_process');
const fs = require('fs/promises');
const { runTests } = require('@vscode/test-electron');

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const proc = cp.spawn(command, args, {
      cwd: path.resolve(__dirname, '..'),
      shell: false,
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
  if (process.platform !== 'win32') {
    return;
  }

  try {
    await runCommand('taskkill', ['/F', '/IM', imageName]);
  } catch {
    // It's fine if the process was not running.
  }
}

async function killDesignerProcesses() {
  if (process.platform === 'win32') {
    await killProcessByImage('Demo.XamlDesigner.exe');
    await killProcessByImage('XamlDesigner.exe');
    return;
  }

  try {
    await runCommand('pkill', ['-f', 'Demo.XamlDesigner.dll']);
  } catch {
    // It's fine if the process was not running.
  }
}

async function findMsBuildExe() {
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  const fs = require('fs');
  if (!fs.existsSync(vswhere)) {
    return null;
  }

  return new Promise(resolve => {
    const proc = cp.spawn(
      vswhere,
      ['-latest', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'],
      { shell: false }
    );
    let output = '';
    proc.stdout?.on('data', d => { output += d.toString(); });
    proc.on('close', () => {
      const msbuild = output.trim().split('\n')[0]?.trim();
      resolve(msbuild && fs.existsSync(msbuild) ? msbuild : null);
    });
    proc.on('error', () => resolve(null));
  });
}

async function prepareStubExtensionDependency(extensionsDir, publisher, name) {
  const extensionDir = path.join(extensionsDir, `${publisher}.${name}-0.0.0`);
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(
    path.join(extensionDir, 'package.json'),
    JSON.stringify({
      name,
      publisher,
      displayName: `${publisher}.${name} test stub`,
      version: '0.0.0',
      engines: { vscode: '^1.101.0' },
      activationEvents: [],
      main: './extension.js',
    }, null, 2)
  );
  await fs.writeFile(
    path.join(extensionDir, 'extension.js'),
    'exports.activate = function activate() {}; exports.deactivate = function deactivate() {};\n'
  );
}

async function prepareStubExtensionDependencies(repoRoot) {
  const extensionsDir = path.join(repoRoot, '.vscode-test', 'extensions');
  await prepareStubExtensionDependency(extensionsDir, 'ms-dotnettools', 'vscode-dotnet-runtime');
  await prepareStubExtensionDependency(extensionsDir, 'ms-dotnettools', 'csharp');
  await prepareStubExtensionDependency(extensionsDir, 'lextudio', 'sharpdbg');
}

async function patchPackageManifestForTests(repoRoot) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const originalText = await fs.readFile(packageJsonPath, 'utf8');
  const manifest = JSON.parse(originalText);
  delete manifest.extensionDependencies;
  await fs.writeFile(packageJsonPath, JSON.stringify(manifest, null, 2) + '\n');
  return async () => {
    await fs.writeFile(packageJsonPath, originalText);
  };
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VSCODE_')) {
      delete process.env[key];
    }
  }

  const repoRoot = path.resolve(__dirname, '..');
  const extensionDevelopmentPath = repoRoot;
  const extensionTestsPath = path.join(repoRoot, 'out', 'test', 'test', 'suite', 'index.js');
  const sampleProject = path.join(repoRoot, 'sample', 'net6.0', 'sample.csproj');
  const frameworkSampleProject = path.join(repoRoot, 'sample', 'net462', 'sample.csproj');
  const sharpDbgProject = path.join(repoRoot, 'external', 'SharpDbg', 'src', 'SharpDbg.Cli', 'SharpDbg.Cli.csproj');
  const localVsCodeExecutablePath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
  const suite = process.env.WPF_TEST_SUITE || 'default';

  let restorePackageManifest = async () => {};

  try {
    await prepareStubExtensionDependencies(repoRoot);
    restorePackageManifest = await patchPackageManifestForTests(repoRoot);

    await killProcessByImage('sample.exe');
    await killProcessByImage('SharpDbg.Cli.exe');
    await killDesignerProcesses();

    if (suite !== 'designer') {
      await runCommand('dotnet', ['build', sharpDbgProject, '--configuration', 'Debug', '-nologo']);
    }
    await runCommand('dotnet', ['build', sampleProject, '--configuration', 'Debug', '-nologo']);

    if (suite === 'designer') {
      process.env.WPF_SKIP_NETFX_TESTS = '1';
    } else {
      const msbuild = await findMsBuildExe();
      if (!msbuild) {
        console.warn('WARNING: MSBuild.exe not found via vswhere — skipping net462 sample build and tests.');
        process.env.WPF_SKIP_NETFX_TESTS = '1';
      } else {
        await runCommand(msbuild, [frameworkSampleProject, '/p:Configuration=Debug', '/nologo', '/v:m']);
        process.env.WPF_SKIP_NETFX_TESTS = '0';
      }
    }

    const runOptions = {
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [repoRoot],
      extensionTestsEnv: {
        WPF_REPO_ROOT: repoRoot,
        WPF_TEST_SUITE: suite,
        WPF_DESIGNER_PROCESS_LOG: path.join(repoRoot, '.vscode-test', 'designer-process.log'),
        WPF_SKIP_NETFX_TESTS: process.env.WPF_SKIP_NETFX_TESTS,
      },
      version: '1.101.0',
    };
    if (process.platform === 'win32') {
      runOptions.vscodeExecutablePath = localVsCodeExecutablePath;
    }

    await runTests(runOptions);
  } finally {
    await restorePackageManifest();
    await killProcessByImage('sample.exe');
    await killProcessByImage('SharpDbg.Cli.exe');
    await killDesignerProcesses();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

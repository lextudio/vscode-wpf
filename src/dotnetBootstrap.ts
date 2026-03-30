import * as vscode from 'vscode';

const DOTNET_INSTALL_EXTENSION_ID = 'ms-dotnettools.vscode-dotnet-runtime';
const REQUESTING_EXTENSION_ID = 'lextudio.vscode-wpf';
const REQUIRED_DOTNET_RUNTIME_VERSION = '10.0';

interface DotnetAcquireResult {
  dotnetPath: string;
}

let acquiredDotnetPath: string | null = null;
let ensureRuntimePromise: Promise<string | null> | null = null;

export async function ensureDotnetRuntime(): Promise<string | null> {
  if (acquiredDotnetPath) {
    return acquiredDotnetPath;
  }

  const configuredPath = getConfiguredDotnetPath();
  if (configuredPath && configuredPath !== 'dotnet') {
    acquiredDotnetPath = configuredPath;
    return acquiredDotnetPath;
  }

  if (ensureRuntimePromise) {
    return ensureRuntimePromise;
  }

  ensureRuntimePromise = acquireDotnetRuntime();
  try {
    acquiredDotnetPath = await ensureRuntimePromise;
    return acquiredDotnetPath;
  } finally {
    ensureRuntimePromise = null;
  }
}

export function getPreferredDotnetPath(): string {
  return acquiredDotnetPath ?? getConfiguredDotnetPath() ?? 'dotnet';
}

function getConfiguredDotnetPath(): string | null {
  const configured = vscode.workspace.getConfiguration('wpf').get<string>('dotnetPath', 'dotnet').trim();
  return configured.length > 0 ? configured : null;
}

async function acquireDotnetRuntime(): Promise<string | null> {
  const extension = vscode.extensions.getExtension(DOTNET_INSTALL_EXTENSION_ID);
  if (!extension) {
    return getConfiguredDotnetPath() ?? 'dotnet';
  }

  await extension.activate();

  try {
    const result = await vscode.commands.executeCommand<DotnetAcquireResult | undefined>(
      'dotnet.acquire',
      {
        version: REQUIRED_DOTNET_RUNTIME_VERSION,
        requestingExtensionId: REQUESTING_EXTENSION_ID,
        installType: 'local',
        mode: 'runtime',
      }
    );

    return result?.dotnetPath ?? getConfiguredDotnetPath() ?? 'dotnet';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(
      `Unable to acquire .NET ${REQUIRED_DOTNET_RUNTIME_VERSION} runtime automatically: ${message}`
    );
    return getConfiguredDotnetPath() ?? 'dotnet';
  }
}

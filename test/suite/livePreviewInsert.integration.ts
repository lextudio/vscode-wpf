import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

type InsertResult = {
  ok: boolean;
  message: string;
};

type LivePreviewToolboxItem = {
  kind: 'wpfToolboxItem';
  displayName: string;
  typeName: string;
  xmlNamespace?: string;
  clrNamespace?: string;
  assemblyName?: string;
  prefixHint?: string;
  requiresPrefix: boolean;
  defaultSnippet: string;
};

export async function run(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-wpf-insert-'));
  try {
    await testPanelInsertExpandsSelfClosing(tempDir);
    await testContentControlRejectsExistingContent(tempDir);
    await testFallsBackToNearestAncestorContainer(tempDir);
    await testFallsBackWhenSelfClosingContentAttributeExists(tempDir);
    await testNamespaceInjectionForCustomControl(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testPanelInsertExpandsSelfClosing(tempDir: string): Promise<void> {
  const xamlPath = path.join(tempDir, 'panel-self-closing.xaml');
  const original = `<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Name="Root" />`;
  await fs.writeFile(xamlPath, original, 'utf8');

  const item: LivePreviewToolboxItem = {
    kind: 'wpfToolboxItem',
    displayName: 'Button',
    typeName: 'System.Windows.Controls.Button',
    xmlNamespace: 'http://schemas.microsoft.com/winfx/2006/xaml/presentation',
    requiresPrefix: false,
    defaultSnippet: '<Button Content="Hello" />',
  };

  const result = await vscode.commands.executeCommand<InsertResult>(
    'wpf._test.applyLivePreviewToolboxInsert',
    {
      xamlPath,
      elementName: 'Root',
      typeName: 'Grid',
      item,
    }
  );

  assert.ok(result?.ok, `Expected insertion to succeed, got: ${result?.message ?? '(no result)'}`);
  const updated = await fs.readFile(xamlPath, 'utf8');
  assert.ok(updated.includes('<Grid'), 'Expected Grid root to remain.');
  assert.ok(updated.includes('<Button Content="Hello" />'), 'Expected child snippet inserted.');
  assert.ok(updated.includes('</Grid>'), 'Expected self-closing Grid to be expanded.');
}

async function testContentControlRejectsExistingContent(tempDir: string): Promise<void> {
  const xamlPath = path.join(tempDir, 'content-existing.xaml');
  const original = `<Button xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" x:Name="Host"><TextBlock Text="Existing" /></Button>`;
  await fs.writeFile(xamlPath, original, 'utf8');

  const item: LivePreviewToolboxItem = {
    kind: 'wpfToolboxItem',
    displayName: 'Label',
    typeName: 'System.Windows.Controls.Label',
    xmlNamespace: 'http://schemas.microsoft.com/winfx/2006/xaml/presentation',
    requiresPrefix: false,
    defaultSnippet: '<Label Content="Inserted" />',
  };

  const result = await vscode.commands.executeCommand<InsertResult>(
    'wpf._test.applyLivePreviewToolboxInsert',
    {
      xamlPath,
      elementName: 'Host',
      typeName: 'Button',
      item,
    }
  );

  assert.ok(result && !result.ok, 'Expected insertion to be rejected for non-empty ContentControl.');
  assert.ok(
    (result?.message ?? '').includes('already has content'),
    `Expected content guardrail message, got: ${result?.message ?? '(no result)'}`
  );
}

async function testNamespaceInjectionForCustomControl(tempDir: string): Promise<void> {
  const xamlPath = path.join(tempDir, 'namespace-injection.xaml');
  const original = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        x:Class="Sample.MainWindow">
    <Grid x:Name="Root" />
</Window>`;
  await fs.writeFile(xamlPath, original, 'utf8');

  const item: LivePreviewToolboxItem = {
    kind: 'wpfToolboxItem',
    displayName: 'UserControl (local)',
    typeName: 'MyApp.Controls.MyControl',
    clrNamespace: 'MyApp.Controls',
    assemblyName: 'MyApp',
    prefixHint: 'local',
    requiresPrefix: true,
    defaultSnippet: '<local:MyControl />',
  };

  const result = await vscode.commands.executeCommand<InsertResult>(
    'wpf._test.applyLivePreviewToolboxInsert',
    {
      xamlPath,
      elementName: 'Root',
      typeName: 'Grid',
      item,
    }
  );

  assert.ok(result?.ok, `Expected insertion to succeed, got: ${result?.message ?? '(no result)'}`);
  const updated = await fs.readFile(xamlPath, 'utf8');
  assert.ok(
    updated.includes('xmlns:local="clr-namespace:MyApp.Controls;assembly=MyApp"'),
    'Expected local namespace declaration to be injected.'
  );
  assert.ok(updated.includes('<local:MyControl />'), 'Expected custom control snippet inserted.');
}

async function testFallsBackToNearestAncestorContainer(tempDir: string): Promise<void> {
  const xamlPath = path.join(tempDir, 'ancestor-fallback.xaml');
  const original = `<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Name="Root">
    <Button x:Name="HostButton">
        <TextBlock Text="Existing" />
    </Button>
</Grid>`;
  await fs.writeFile(xamlPath, original, 'utf8');

  const item: LivePreviewToolboxItem = {
    kind: 'wpfToolboxItem',
    displayName: 'Label',
    typeName: 'System.Windows.Controls.Label',
    xmlNamespace: 'http://schemas.microsoft.com/winfx/2006/xaml/presentation',
    requiresPrefix: false,
    defaultSnippet: '<Label Content="Inserted via fallback" />',
  };

  const result = await vscode.commands.executeCommand<InsertResult>(
    'wpf._test.applyLivePreviewToolboxInsert',
    {
      xamlPath,
      elementName: 'HostButton',
      typeName: 'Button',
      item,
    }
  );

  assert.ok(result?.ok, `Expected ancestor fallback insertion to succeed, got: ${result?.message ?? '(no result)'}`);
  assert.ok(
    (result?.message ?? '').includes('into Grid'),
    `Expected insertion target to report Grid fallback, got: ${result?.message ?? '(no result)'}`
  );

  const updated = await fs.readFile(xamlPath, 'utf8');
  assert.ok(updated.includes('<Button x:Name="HostButton">'), 'Expected original target element to remain.');
  assert.ok(
    updated.includes('<Label Content="Inserted via fallback" />'),
    'Expected fallback snippet inserted into ancestor container.'
  );
}

async function testFallsBackWhenSelfClosingContentAttributeExists(tempDir: string): Promise<void> {
  const xamlPath = path.join(tempDir, 'self-closing-content-fallback.xaml');
  const original = `<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Name="Root">
    <Button x:Name="HostButton" Content="Already set" />
</Grid>`;
  await fs.writeFile(xamlPath, original, 'utf8');

  const item: LivePreviewToolboxItem = {
    kind: 'wpfToolboxItem',
    displayName: 'TextBlock',
    typeName: 'System.Windows.Controls.TextBlock',
    xmlNamespace: 'http://schemas.microsoft.com/winfx/2006/xaml/presentation',
    requiresPrefix: false,
    defaultSnippet: '<TextBlock Text="Inserted from fallback" />',
  };

  const result = await vscode.commands.executeCommand<InsertResult>(
    'wpf._test.applyLivePreviewToolboxInsert',
    {
      xamlPath,
      elementName: 'HostButton',
      typeName: 'Button',
      item,
    }
  );

  assert.ok(result?.ok, `Expected fallback insertion to succeed, got: ${result?.message ?? '(no result)'}`);
  assert.ok(
    (result?.message ?? '').includes('into Grid'),
    `Expected insertion target to report Grid fallback, got: ${result?.message ?? '(no result)'}`
  );

  const updated = await fs.readFile(xamlPath, 'utf8');
  assert.ok(updated.includes('Content="Already set"'), 'Expected original button content attribute to remain.');
  assert.ok(
    updated.includes('<TextBlock Text="Inserted from fallback" />'),
    'Expected dropped element to be inserted into ancestor container.'
  );
}

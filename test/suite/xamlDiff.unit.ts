import * as assert from 'assert';
import { classifyXamlChange } from '../../src/runtimeHotReload';

export async function run(): Promise<void> {
  testPropertyOnlyChange();
  testSubtreeChangeChildAdded();
  testSubtreeChangeChildRemoved();
  testResourceDictionary();
  testXClassChanged();
  testRootTagChanged();
  testNoChange();
  testFirstPush();
  testAttributeRemoved();
  testMultiplePropertyChanges();
}

function testPropertyOnlyChange(): void {
  const oldXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    x:Class="MyApp.MainWindow">
    <Button x:Name="PrimaryButton" Background="Red" Content="Click me" />
</Window>`;

  const newXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    x:Class="MyApp.MainWindow">
    <Button x:Name="PrimaryButton" Background="Green" Content="Click me" />
</Window>`;

  const result = classifyXamlChange(oldXaml, newXaml);
  assert.strictEqual(result.changeKind, 'property', 'Expected property change for attribute value edit');
  assert.strictEqual(result.propertyChanges.length, 1);
  assert.strictEqual(result.propertyChanges[0].property, 'Background');
  assert.strictEqual(result.propertyChanges[0].newValue, 'Green');
  assert.strictEqual(result.propertyChanges[0].elementName, 'PrimaryButton');
}

function testSubtreeChangeChildAdded(): void {
  const oldXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <StackPanel>
        <Button Content="A" />
    </StackPanel>
</Window>`;

  const newXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <StackPanel>
        <Button Content="A" />
        <Button Content="B" />
    </StackPanel>
</Window>`;

  const result = classifyXamlChange(oldXaml, newXaml);
  assert.strictEqual(result.changeKind, 'subtree', 'Expected subtree change when child added');
}

function testSubtreeChangeChildRemoved(): void {
  const oldXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <StackPanel>
        <Button Content="A" />
        <Button Content="B" />
    </StackPanel>
</Window>`;

  const newXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <StackPanel>
        <Button Content="A" />
    </StackPanel>
</Window>`;

  const result = classifyXamlChange(oldXaml, newXaml);
  assert.strictEqual(result.changeKind, 'subtree', 'Expected subtree change when child removed');
}

function testResourceDictionary(): void {
  const oldXaml = `<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <SolidColorBrush x:Key="Accent" Color="Blue" />
</ResourceDictionary>`;

  const newXaml = `<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <SolidColorBrush x:Key="Accent" Color="Red" />
</ResourceDictionary>`;

  const result = classifyXamlChange(oldXaml, newXaml);
  assert.strictEqual(result.changeKind, 'resource', 'Expected resource change for ResourceDictionary edits');
}

function testXClassChanged(): void {
  const oldXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    x:Class="MyApp.MainWindow">
</Window>`;

  const newXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    x:Class="MyApp.OtherWindow">
</Window>`;

  const result = classifyXamlChange(oldXaml, newXaml);
  assert.strictEqual(result.changeKind, 'restart', 'Expected restart when x:Class changes');
}

function testRootTagChanged(): void {
  const oldXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
</Window>`;

  const newXaml = `<UserControl xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
</UserControl>`;

  const result = classifyXamlChange(oldXaml, newXaml);
  assert.strictEqual(result.changeKind, 'fullFile', 'Expected fullFile when root tag changes');
}

function testNoChange(): void {
  const xaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <Button Content="OK" />
</Window>`;

  const result = classifyXamlChange(xaml, xaml);
  assert.strictEqual(result.changeKind, 'fullFile', 'Expected fullFile for no detectable changes (safety net)');
  assert.strictEqual(result.propertyChanges.length, 0);
}

function testFirstPush(): void {
  const newXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <Button Content="OK" />
</Window>`;

  const result = classifyXamlChange(undefined, newXaml);
  assert.strictEqual(result.changeKind, 'fullFile', 'Expected fullFile for first push (no previous)');
}

function testAttributeRemoved(): void {
  const oldXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <Button Content="OK" IsEnabled="False" />
</Window>`;

  const newXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <Button Content="OK" />
</Window>`;

  const result = classifyXamlChange(oldXaml, newXaml);
  assert.strictEqual(result.changeKind, 'subtree', 'Expected subtree when attribute removed');
}

function testMultiplePropertyChanges(): void {
  const oldXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    x:Class="MyApp.MainWindow" Title="Old Title">
    <Button x:Name="Btn" Background="Red" Content="Old" />
</Window>`;

  const newXaml = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    x:Class="MyApp.MainWindow" Title="New Title">
    <Button x:Name="Btn" Background="Green" Content="New" />
</Window>`;

  const result = classifyXamlChange(oldXaml, newXaml);
  assert.strictEqual(result.changeKind, 'property', 'Expected property for multi-attribute edits');
  assert.ok(result.propertyChanges.length >= 3, `Expected at least 3 property changes, got ${result.propertyChanges.length}`);

  const bgChange = result.propertyChanges.find(c => c.property === 'Background');
  assert.ok(bgChange, 'Expected Background property change');
  assert.strictEqual(bgChange!.newValue, 'Green');
  assert.strictEqual(bgChange!.elementName, 'Btn');

  const titleChange = result.propertyChanges.find(c => c.property === 'Title');
  assert.ok(titleChange, 'Expected Title property change');
  assert.strictEqual(titleChange!.newValue, 'New Title');
}

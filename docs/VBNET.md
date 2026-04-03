# VB.NET WPF Support Notes

## Question

How does a VB.NET WPF sample look, and can we support `.vbproj` in this extension?

## Short Answer

Yes. We can support VB.NET WPF for the existing extension workflows (project detection, designer, hot reload routing, and XAML file navigation) with small and safe updates.

## Template Availability

Yes, the CLI template exists.

```powershell
dotnet new wpf --language VB --framework net6.0 -n MyVbWpfApp
```

## VB.NET WPF Sample (SDK-style)

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net6.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
    <RootNamespace>sample</RootNamespace>
  </PropertyGroup>
</Project>
```

```xml
<Window x:Class="MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="VB.NET WPF Sample">
  <Grid>
    <Button x:Name="PrimaryButton" Content="VB Button" />
  </Grid>
</Window>
```

```vb
Class MainWindow
End Class
```

## What Was Implemented

1. Project discovery now supports both `.csproj` and `.vbproj`.
2. WPF project picker and status bar now display project names correctly for both extensions.
3. Explorer context menu for `WPF: Open XAML File` now appears for `.vbproj` too.
4. Event handler fallback insertion now supports `.xaml.vb` in addition to `.xaml.cs`.
5. Runtime helper staleness checks now watch `.vb` and `.vbproj` files too.
6. Added a complete VB sample under `sample/net6.0-vb.net/`.

## Temporary Limitation

`{cs: ...}` C# expression markup is **not supported for `.vbproj` projects** for now.

Reason:
the expression pipeline currently assumes C# semantics/codegen in the generator layer.

Scope of impact:
regular XAML IntelliSense, designer, and hot reload still work; only C# expression markup is excluded for VB.

## New VB Sample Path

`sample/net6.0-vb.net/`

Includes:

1. `sample.vbproj`
2. `Application.xaml` / `Application.xaml.vb`
3. `MainWindow.xaml` / `MainWindow.xaml.vb`
4. `AssemblyInfo.vb`

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

## XSG Gap Check (VB.NET)

I tried enabling WXSG on `sample/net6.0-vb.net` directly:

```xml
<WpfXsgEnabled>true</WpfXsgEnabled>
<WpfXsgTargetLanguage>VisualBasic</WpfXsgTargetLanguage>
<PackageReference Include="XamlToCSharpGenerator.Generator.WPF" Version="0.1.2-5" PrivateAssets="all" />
```

### Observed failure before fix

`vbc : error BC30420: 'Sub Main' was not found in 'sample'.`

Root cause:
the WXSG build target removed WPF `ApplicationDefinition` for all languages, but WXSG currently emits only C# source. On VB projects this disabled default WPF startup generation without a VB replacement path.

### Toolset improvement implemented

`XamlToCSharpGenerator.Build.WPF.targets` is now language-aware:

1. WXSG transform path runs only when `$(Language) == 'C#'`.
2. VB projects with `WpfXsgEnabled=true` fall back to standard WPF markup compiler (safe build behavior).
3. Build prints a clear high-importance message explaining the fallback.
4. AdditionalFiles classification now uses real `@(Page)` / `@(ApplicationDefinition)` item groups instead of hard-coded `App.xaml` filename checks.
5. Added `WpfXsgTargetLanguage` property (`CSharp` / `VisualBasic`) as explicit user intent.
6. Added a VB.NET generator pipeline:
   - `WpfXamlVisualBasicSourceGenerator` (Roslyn VB generator entry)
   - `WpfVisualBasicCodeEmitter` (VB source emission)
   - package now ships analyzer payloads for both `analyzers/dotnet/cs` and `analyzers/dotnet/vb`.

### Result after fix

VB sample builds successfully with WXSG package in VB mode.
`AXSG0002` (missing `x:Class`) for template-style VB XAML and false-positive `AXSG0109` warnings are resolved.

## Current VB Emitter Status

WXSG can now run in VB mode:

```xml
<WpfXsgEnabled>true</WpfXsgEnabled>
<WpfXsgTargetLanguage>VisualBasic</WpfXsgTargetLanguage>
```

What works:

1. VB project builds successfully with WXSG package + VB target language.
2. Markup compiler-generated `.g.vb` compile items are suppressed in WXSG VB mode to avoid duplicate symbols.
3. VB generator emits source with BAML-backed `InitializeComponent` and app `Main()` entrypoint.
4. Template-style unqualified `x:Class` values are handled via inferred class mapping in VB mode.
5. Non-C# projects skip C#-only partial-class validation, avoiding false AXSG0109 warnings.

### Build verification tip

If you are iterating on local package changes, force clean restore:

```powershell
dotnet restore sample/net6.0-vb.net/sample.vbproj --no-cache
```

## New VB Sample Path

`sample/net6.0-vb.net/`

Includes:

1. `sample.vbproj`
2. `Application.xaml` / `Application.xaml.vb`
3. `MainWindow.xaml` / `MainWindow.xaml.vb`
4. `AssemblyInfo.vb`

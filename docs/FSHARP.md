# F# WPF Support Notes

## Question

Can we support F# WPF projects in this extension and WXSG, similar to VB.NET?

## Short Answer

Yes, with a prototype WXSG backend for F#.

1. Extension support now includes `.fsproj` end-to-end for project detection/picker and WPF commands.
2. WXSG now has an F# MSBuild prototype path that generates `.g.fs` files before compile.
3. This avoids the F# WPF markup-compiler `MC1000` crash in this environment by bypassing WPF markup compile in F# WXSG mode.

## Template Availability

On this machine (SDK `10.0.201`), `dotnet new wpf --language F#` is not available.
Allowed `wpf` template languages are C# and VB.

## F# Sample

Path: `sample/net6.0-fsharp/`

### sample.fsproj

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
    <WpfXsgEnabled>true</WpfXsgEnabled>
    <WpfXsgTargetLanguage>FSharp</WpfXsgTargetLanguage>
    <RestoreSources>$(MSBuildProjectDirectory)\..\..\artifacts\local-packages;$(RestoreSources)</RestoreSources>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="XamlToCSharpGenerator.Generator.WPF" Version="0.1.2-5" PrivateAssets="all" />
  </ItemGroup>

  <ItemGroup>
    <Compile Include="Program.fs" />
  </ItemGroup>
</Project>
```

### Program.fs

```fsharp
namespace sample

open System

module Program =
    [<STAThread>]
    [<EntryPoint>]
    let main _ =
        let app = App()
        app.InitializeComponent()

        let window = MainWindow()
        window.InitializeComponent()

        app.Run(window)
```

`App` and `MainWindow` are generated from `Application.xaml` / `MainWindow.xaml` by WXSG F# mode.

## Extension Changes Implemented

1. `.fsproj` included in project discovery and picker logic.
2. `.fsproj` accepted in project-path validation.
3. Explorer context menu `WPF: Open XAML File` now appears for `.fsproj`.
4. Runtime/design-time staleness watchers now include `.fs` and `.fsproj`.
5. `.xaml.fs` code-behind path detection added.

### Event-handler fallback insertion

When the language server does not provide a code action, the extension falls back to
text-based stub insertion.  For F# code-behind (`.xaml.fs`) the fallback:

- detects an existing handler via `/\bmember\s+(?:this|_)\.HandlerName\s*\(/`
- finds the insertion point after the last `member` definition (or end-of-file)
- inserts a stub: `member this.HandlerName(sender: obj, e: EventArgs) = ()`

## WXSG F# Prototype Changes

In `XamlToCSharpGenerator.Build.WPF.targets`:

1. `WpfXsgTargetLanguage` now accepts `F#` / `FSharp`.
2. Added `WpfXsgFSharpMode` mode detection.
3. Added `WxsgGenerateFSharpCode` inline MSBuild task (`RoslynCodeTaskFactory`) that:
   - reads XAML with `x:Class`,
   - emits generated `.wxsg.g.fs` files under `obj/.../wxsg/fsharp/`.
   - collects `x:Name` elements and emits typed `let mutable __name` fields with `FindName` wiring.
   - exposes each named element as a read-only `member _.``name``` property.
4. F# mode moves `Page` / `ApplicationDefinition` out of WPF markup compile inputs (to avoid `MC1000`).
5. F# mode copies XAML files as loose content to output.
6. Generated `.g.fs` files are injected into `Compile` in deterministic order before user files.

### Named-element access pattern

Given `<Button x:Name="myBtn" .../>` in XAML, the generated code produces:

```fsharp
let mutable __myBtn : System.Windows.Controls.Button = Unchecked.defaultof<_>
// in InitializeComponent, before content is moved to this:
__myBtn <- __loaded.FindName("myBtn") :?> System.Windows.Controls.Button
// public accessor:
member _.``myBtn`` = __myBtn
```

The WPF type is resolved from a built-in mapping that covers ~50 common controls
(`Button`, `TextBlock`, `Grid`, `ListBox`, etc.) with `FrameworkElement` as fallback
for unrecognised elements.

### Application XAML loading

`XamlReader.Load(Application.xaml)` instantiates the `x:Class` type, which would
create a second `Application` — WPF forbids this (singleton constraint).
The generated `App.InitializeComponent()` therefore parses the XAML as plain XML via
`XDocument.Load` and extracts only what it needs:

- `StartupUri` attribute → `this.StartupUri`
- Top-level `<Application.Resources>` children → `this.Resources.MergedDictionaries`
  (each child is loaded with `XamlReader.Parse` as a `ResourceDictionary`)

## Current Prototype Limits

1. Typed `x:Name` field generation covers common controls via a static name→type map;
   custom controls and third-party elements fall back to `System.Windows.FrameworkElement`.
2. F# has no partial classes, so code-behind is not separated from the generated type
   the way C#/VB code-behind files are.
3. This is an MSBuild prototype backend, not Roslyn analyzer/source-generator execution in F#.

## Verification

```powershell
dotnet restore sample/net6.0-fsharp/sample.fsproj --no-cache
dotnet build sample/net6.0-fsharp/sample.fsproj --no-incremental --no-restore
npm run build
```

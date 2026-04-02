# WXSG — WPF XAML Source Generator

## Overview

WXSG is a Roslyn incremental source generator for WPF that follows the same architecture as AXSG
(the Avalonia XAML Source Generator in `external/XamlToCSharpGenerator`). Where AXSG bypasses
Avalonia's default XamlX/XamlIL compiler backend, WXSG bypasses WPF's BAML-based code generation
(`MarkupCompilePass1` / `MarkupCompilePass2`) with pure C# source generation.

WXSG is **not a separate tool** — it extends the existing XSG engine by adding a WPF framework
profile alongside the existing Avalonia profile.

## Why WXSG?

| Concern | WPF default (BAML) | WXSG |
|---------|-------------------|------|
| Code generation | MSBuild tasks, opaque | Roslyn source gen, debuggable |
| C# expressions in XAML | Not supported | Supported (Phase 5) |
| Type safety for x:Name | Runtime cast | Compile-time typed field |
| AOT / NativeAOT | Reflection-heavy BAML | Pure C#, AOT-friendly (Phase 3+) |
| Hot reload integration | Limited | IDE-driven partial recompilation |
| IDE comprehension | Binary BAML | C# source, full IntelliSense |

## Architecture

WXSG reuses the entire XSG compilation pipeline:

```
XamlToCSharpGenerator.Compiler
  └── XamlSourceGeneratorCompilerHost.Initialize()
        ├── Transform rules     → WpfFrameworkTransformProvider (no-op)
        ├── XAML discovery      → WpfFrameworkBuildContract  (Page / ApplicationDefinition items)
        ├── XML parsing         → shared SimpleXamlDocumentParser
        ├── Semantic binding    → WpfSemanticBinder  (IXamlSemanticBinder)
        └── Code emission       → WpfCodeEmitter     (IXamlCodeEmitter)
```

New WPF-specific code lives in:

```
external/XamlToCSharpGenerator/src/
  XamlToCSharpGenerator.WPF/          ← parallel to XamlToCSharpGenerator.Avalonia
    Framework/
      WpfFrameworkProfile.cs          ← IXamlFrameworkProfile (main extension point)
      WpfFrameworkBuildContract.cs    ← Page / ApplicationDefinition MSBuild contract
      WpfFrameworkTransformProvider.cs← no-op (WPF has no .xamlx transform rules)
      WpfXmlNamespaces.cs             ← well-known WPF xmlns URIs
    Binding/
      WpfSemanticBinder.cs            ← IXamlSemanticBinder — type resolution
    Emission/
      WpfCodeEmitter.cs               ← IXamlCodeEmitter — C# code generation

  XamlToCSharpGenerator.Generator/
    WpfXamlSourceGenerator.cs         ← [Generator] entry point, alongside Avalonia one
```

The existing language server (`src/XamlLanguageServer.Wpf`) references
`XamlToCSharpGenerator.WPF` and uses `WpfFrameworkProfile.Instance` for LSP services.

## Key Differences from AXSG

| Aspect | AXSG (Avalonia) | WXSG (WPF) |
|--------|----------------|------------|
| xmlns → CLR namespace | `Avalonia.Metadata.XmlnsDefinitionAttribute` | `System.Windows.Markup.XmlnsDefinitionAttribute` |
| xmlns → prefix hint | `Avalonia.Metadata.XmlnsPrefixAttribute` | `System.Windows.Markup.XmlnsPrefixAttribute` |
| XAML item group | `AvaloniaXaml` | `Page` / `ApplicationDefinition` |
| Transform rules | JSON `.axamlx` files | None |
| Document enrichers | `AvaloniaDocumentFeatureEnricher` | None (Phase 1) |
| Runtime loading | Pure C# (no BAML) | Phase 1: BAML via `LoadComponent`; Phase 3: Pure C# |
| Default xmlns | `https://github.com/avaloniaui` | `http://schemas.microsoft.com/winfx/2006/xaml/presentation` |
| IComponentConnector | Not used | Phase 1: no-op Connect + FindName wiring |

## Implementation Phases

### Phase 1 — Project skeleton + BAML-hybrid codegen ✅ (this PR)

Goals:
- Create `XamlToCSharpGenerator.WPF` project following the Avalonia project structure.
- Implement `WpfSemanticBinder` using `XmlnsDefinitionAttribute` to resolve named-element types.
- Implement `WpfCodeEmitter` that generates a `partial class` with:
  - Typed `x:Name` field declarations
  - `InitializeComponent()` that calls `Application.LoadComponent` (BAML still used at runtime)
  - No-op `IComponentConnector.Connect()` with `FindName`-based field wiring after load
- Add `WpfXamlSourceGenerator` to `XamlToCSharpGenerator.Generator` (same project as `AvaloniaXamlSourceGenerator`).
- MSBuild props/targets that:
  - Feed WPF `<Page>` items to the source generator via `<AdditionalFiles>`.
  - Suppress WPF's default `.g.cs` code generation (keep BAML resource compilation).

Deliverable: A NuGet reference to `XamlToCSharpGenerator.Generator` plus
`XamlToCSharpGenerator.Build.WPF` props/targets is enough to get typed `x:Name` fields and
source-generated `InitializeComponent` for a WPF project.

### Phase 2 — Full semantic binding

Goals:
- `WpfSemanticBinder` resolves all element and attribute names, not just `x:Name` elements.
- Property assignments produce `ResolvedPropertyAssignment` nodes.
- Attached property syntax `Grid.Row="0"` resolved correctly.
- Event subscriptions populated.
- Diagnostics for unknown types and properties.

### Phase 3 — Pure C# emission (no BAML)

Goals:
- `WpfCodeEmitter` generates complete object construction code — no call to `LoadComponent`.
- MSBuild targets disable `MarkupCompilePass1`/`MarkupCompilePass2` entirely.
- XAML files are passed ONLY via `<AdditionalFiles>` (remove `<Page>` build action).
- AOT-safe output.

### Phase 4 — Hot reload integration

Goals:
- Plug into the existing VS Code WPF hot-reload pipeline
  (`src/runtimeHotReload.ts` / `src/WpfHotReload.Runtime`).
- Source-generated classes carry the `__WXSG_HOT_RELOAD__` state field pattern used by AXSG.
- IDE XAML-edit triggers incremental recompilation rather than full restart.

Progress (2026-04-02):
- ✅ Implemented: WXSG emitter now generates `__WXSG_HOT_RELOAD__`, `__WXSG_ApplyHotReload(...)`,
  and reset/collection cleanup helpers for repeated object-graph application.
- ✅ Implemented: runtime hot-reload agent now probes/invokes `__WXSG_ApplyHotReload(...)`
  before falling back to XML/tree patching.
- 🚧 Next: wire incremental compile trigger for WXSG XAML edits (currently runtime apply path is integrated).

### Phase 5 — C# expressions

Goals:
- Inline C# expressions in attribute values: `Text="{cs: item.Name.ToUpper()}"`.
- Compiled bindings: `{Binding Path=Name, Mode=OneWay}` → type-checked at compile time.
- Reuse `XamlToCSharpGenerator.ExpressionSemantics` (already shared with AXSG).

Progress (2026-04-02):
- ✅ Implemented: WXSG binder now parses inline C# attribute expression markup
  (`{cs: ...}`, `{csharp: ...}`, and explicit expression markup supported by
  `CSharpMarkupExpressionSemantics`) and emits raw C# expression assignments.
- ✅ Implemented: WXSG now references `XamlToCSharpGenerator.ExpressionSemantics`
  in WPF/generator projects; sample analyzer wiring updated accordingly.
- ⏳ Pending: compiled-binding type-checking pipeline for WPF.

## MSBuild Integration

Add this to a WPF project to opt in (Phase 1):

```xml
<PropertyGroup>
  <WpfSourceGenEnabled>true</WpfSourceGenEnabled>
</PropertyGroup>
```

The `XamlToCSharpGenerator.Build.WPF` package (to be created as a `buildTransitive` NuGet
alongside `XamlToCSharpGenerator.Build`) will:

1. Add each `<Page>` and `<ApplicationDefinition>` item to `<AdditionalFiles>` with
   `SourceItemGroup=Page` and `TargetPath` metadata set.
2. When `WpfSourceGenEnabled=true`, remove MSBuild-generated `.g.cs` files from the
   `<Compile>` item group after `MarkupCompilePass1` runs so WXSG output wins.

## Current Status

| Component | Status |
|-----------|--------|
| `XamlToCSharpGenerator.WPF` project | ✅ Created |
| `WpfFrameworkProfile` | ✅ Implemented |
| `WpfFrameworkBuildContract` | ✅ Implemented |
| `WpfSemanticBinder` (named-element type resolution) | ✅ Phase 1 |
| `WpfCodeEmitter` (LoadComponent-based + `Main()` for `ApplicationDefinition`) | ✅ Phase 1 |
| `WpfXamlSourceGenerator` in Generator project | ✅ Implemented |
| Language server uses `XamlToCSharpGenerator.WPF` | ✅ Refactored |
| `sample/net6.0-csharp-expressions` demo builds with WXSG Phase 1 | ✅ Working |
| MSBuild `XamlToCSharpGenerator.Build.WPF` targets (NuGet package) | 🚧 TODO |
| Full semantic binding (Phase 2) | ✅ Implemented |
| Pure C# emission (Phase 3) | ✅ Implemented |
| Hot reload (Phase 4) | 🚧 In progress (generated hook + runtime invocation implemented) |
| C# expressions (Phase 5) | 🚧 In progress (inline expression markup implemented) |

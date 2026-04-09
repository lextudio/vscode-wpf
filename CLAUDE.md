# CLAUDE.md

## Project Overview

This is a VS Code extension providing XAML language server support for WPF projects. It includes a XAML language server (`XamlLanguageServer.Wpf`) built on top of a shared XAML-to-C# generator engine (`external/wxsg/`).

## Architecture

### Tiered Compilation System

The language server uses `TieredCompilationProvider` for fast startup:

- **Tier-1 (instant):** Lightweight compilation from WPF framework assemblies only (`WpfFastCompilationProvider`). Provides standard WPF element/attribute completions immediately. Assembly name = `WpfCore`. TypeIndex primed from disk cache (WPF presentation namespace types only).
- **Tier-2 (background):** Full MSBuild compilation via `MsBuildCompilationProvider` (wrapped by `DiagnosticCompilationProvider`). Includes NuGet packages and user-defined types. Loaded via `PrewarmAsync` at server startup.

**Cache invalidation:** When Tier-2 prewarm completes, `OnPrewarmCompleted` callback should call `engine.InvalidateAllOpenDocumentCaches()` to bump URI generations and force re-analysis. Without this, stale Tier-1 analyses remain cached.

### Analysis Cache

- Key: `(Uri, Generation, WorkspaceRoot)` — version checked separately
- `GetSharedAnalysisOptions` always enables all diagnostics so completion/diagnostic requests share analyses
- `InvalidateAllOpenDocumentCaches()` increments generation for all open URIs

### TypeIndex (`AvaloniaTypeIndex`)

- Cached in `ConditionalWeakTable<Compilation, AvaloniaTypeIndex>` (keyed by Compilation object identity)
- Tier-1 index: built by `BuildFromPrecomputedTypes` (XML namespace types only, no CLR namespace scan)
- Tier-2 index: built by `BuildIndex` which calls `PopulateClrNamespaceIndexWithAllAssemblies` (all assemblies including source)
- Lookup for `clr-namespace:` prefixed types goes through `TryGetTypeByClrNamespace`

## Key File Locations

### WPF Server
- `src/XamlLanguageServer.Wpf/Program.cs` — server entry point
- `src/XamlLanguageServer.Wpf/Workspace/WpfFastCompilationProvider.cs` — Tier-1 snapshot builder
- `src/XamlLanguageServer.Wpf/Diagnostics/DiagnosticCompilationProvider.cs` — compilation logging wrapper

### Shared Engine (external/wxsg/)
- `external/wxsg/.../Workspace/TieredCompilationProvider.cs` — tier management
- `external/wxsg/.../XamlLanguageServiceEngine.cs` — analysis cache, `GetAnalysisAsync` (line 765)
- `external/wxsg/.../Analysis/XamlCompilerAnalysisService.cs` — `AnalyzeAsync`, TypeIndex creation (line 107)
- `external/wxsg/.../Completion/XamlCompletionService.cs` — main completion dispatcher
- `external/wxsg/.../Completion/XamlBindingCompletionService.cs` — binding path completion
- `external/wxsg/.../Completion/XamlSemanticSourceTypeResolver.cs` — d:DesignInstance, ambient DataType resolution
- `external/wxsg/.../Symbols/AvaloniaTypeIndex.cs` — type index with CLR namespace lookup
- `external/wxsg/.../LanguageServer/Program.cs` — Avalonia server entry (reference for OnPrewarmCompleted wiring)

## Troubleshooting

### Binding path completion shows "no suggestions"

**Symptom:** d:DesignInstance type resolution fails for binding path completion on child elements, even though it succeeds for other completions.

**Diagnosis:** Check the `compilationAssembly` in the enhanced diagnostic logs:
- If `WpfCore` → stale Tier-1 analysis is being served (missing `OnPrewarmCompleted` invalidation)
- If project name (e.g. `sample`) → TypeIndex construction bug in `PopulateClrNamespaceIndexWithAllAssemblies`

**Resolution chain in `ResolveTypeSymbol`:**
1. TypeIndex: prefix → XML namespace → CLR namespace → `TryGetTypeByClrNamespace`
2. Roslyn fallback: `compilation.GetTypeByMetadataName(fullName)`

Both fail if compilation is Tier-1 (no user types).

### Completion flow for `{Binding Path=}`

1. `XamlBindingCompletionService.TryGetCompletions` is tried first
2. Calls `TryResolveBindingSourceType` → `TryResolveAmbientDataType` → walks element tree up to root
3. Finds `d:DataContext="{d:DesignInstance vm:Type}"` → extracts type token → `ResolveTypeSymbol`
4. If binding completion fails, falls through to `XamlExpressionCompletionService`

## Build

```bash
# Build WPF language server
dotnet build src/XamlLanguageServer.Wpf/XamlLanguageServer.Wpf.csproj

# Build shared engine
dotnet build external/wxsg/external/XamlToCSharpGenerator/src/XamlToCSharpGenerator.LanguageService/XamlToCSharpGenerator.LanguageService.csproj

# Run tests
dotnet test src/XamlLanguageServer.Wpf.Tests/
```

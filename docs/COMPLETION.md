# XAML Completion Latency — Analysis and Improvement Plan

## Problem

The first completion suggestions in a XAML file take several seconds to appear.
The user experience is a blank IntelliSense popup (or no popup at all) until the
language server finishes loading.

---

## Root Cause Analysis

The latency accumulates through three sequential stages:

### Stage 1 — Server cold start (~0.3–0.8 s)

`wpf-xaml-ls.exe` is a .NET process. On first invocation, the CLR must JIT all
touched methods. The binary is published as a standard `Debug`/`Release` build
with no ReadyToRun metadata, so every hot path (Roslyn symbol APIs, LSP message
dispatch, MSBuild resolver) is JIT-compiled at first use.

### Stage 2 — Lazy compilation provider instantiation (deferred until first request)

`DeferredCompilationProvider` wraps the real `MsBuildCompilationProvider` and
creates it lazily — only when `GetCompilationAsync` is first called. That call
comes from the completion handler, meaning the *user* pays the initialization
cost at interaction time, not at server startup.

### Stage 3 — MSBuild workspace evaluation (dominant bottleneck, 3–15 s)

When `MsBuildCompilationProvider.GetCompilationAsync` runs for the first time it
calls `MSBuildWorkspace.OpenProjectAsync`. This triggers a full MSBuild design-time
evaluation: SDK resolution, NuGet restore graph, project reference traversal, and
assembly reference resolution. On a typical WPF project this takes 3–15 seconds
depending on project complexity and disk speed.

Only after `OpenProjectAsync` completes does `Project.GetCompilationAsync` load
Roslyn metadata references into memory (~0.5–2 s more).

**The result**: the first completion keystroke blocks for the entire Stage 2 + 3
duration before any items appear.

---

## Improvement Ideas

### Idea 1 — Eager warm-up on `textDocument/didOpen` (high impact, low risk)

Trigger `GetCompilationAsync` as a background task the moment the language server
receives the first `textDocument/didOpen` notification for a XAML file, rather
than waiting for `textDocument/completion`.

This front-loads the MSBuild evaluation to occur in parallel while the user reads
the file. In most cases, by the time they type the first `<`, the compilation is
ready.

**Where to implement**: inside `AxsgLanguageServer` (or a notification handler in
`XamlLanguageServiceEngine`) that fires compilation loading on `didOpen`.

**Cost**: low — single background `Task.Run` call with fire-and-forget. The
completion handler already handles a null/loading compilation gracefully.

---

### Idea 2 — Publish with ReadyToRun (low impact, zero risk)

Add `<PublishReadyToRun>true</PublishReadyToRun>` to `XamlLanguageServer.Wpf.csproj`
and publish the binary. R2R pre-compiles hot paths to native code at publish time,
reducing Stage 1 from ~0.5 s to ~0.1 s.

Combined with `<TieredCompilation>true</TieredCompilationQuickJit>false</TieredCompilationQuickJit>`,
this also eliminates the stutter from tier-0 → tier-1 JIT transitions during the
first few completions.

**Where to implement**: `XamlLanguageServer.Wpf.csproj` and the extension's build
script / `package.json` `build` command.

---

### Idea 3 — Static WPF type database for fast syntactic completions (high impact, medium effort)

Many completion contexts — element names, attribute names, XML namespace prefixes —
do not require a Roslyn compilation at all. The WPF type hierarchy is stable across
SDK versions (PresentationFramework, PresentationCore, WindowsBase ship with the
SDK). A pre-built JSON index of all public `DependencyObject` subtypes with their
properties and events, embedded into the server binary, could serve these common
completions instantly from memory without waiting for MSBuild.

The Roslyn compilation would then only be required for:
- Binding path completions (`{Binding Path=...}`)
- User-defined types (`xmlns:local="clr-namespace:MyApp"`)
- Event handler name resolution

**Architecture**: an `IXamlCompletionProvider` implementation that consults the
static database first and falls back to the Roslyn-backed provider. Since the WPF
framework assemblies are part of the host SDK (`net10.0-windows`), the database
could be generated at build time by reflecting over `PresentationFramework.dll`
and serialized to a JSON/binary resource.

---

### Idea 4 — LSP progress notification while compilation loads (low impact, zero risk)

While the compilation is loading, respond to `textDocument/completion` requests
immediately with an empty list but send a `$/progress` notification (or a status
bar item via `window/showMessage`) to tell the user "XAML type information is
loading…". This does not reduce the wait but eliminates the confusion of a silent,
empty IntelliSense popup.

**Where to implement**: `XamlLanguageServiceEngine` — detect when the compilation
is not yet ready, fire a `window/showMessage` or `$/progress` start token, resolve
once the compilation is loaded.

---

### Idea 5 — Persist MSBuild evaluation cache to disk (medium impact, medium effort)

`MSBuildWorkspace` evaluation results (reference assembly paths and metadata) could
be persisted to a file-based cache keyed on `(projectPath, lastWriteTime)`. On
subsequent server starts, if the project file has not changed, skip
`OpenProjectAsync` and re-hydrate the Roslyn workspace directly from the cached
reference list.

Roslyn supports constructing a `Project`/`Compilation` directly from a
`MetadataReference` list, so the cache only needs to store the resolved assembly
paths (not the full workspace state).

**Risk**: cache invalidation — NuGet restore, global.json changes, and SDK updates
all change the resolved reference set without touching `*.csproj` directly. A safe
key includes the project file hash, `global.json` hash, and NuGet lock-file hash.

---

## Recommended Priority

| # | Idea | Effort | Impact | Risk |
|---|------|--------|--------|------|
| 1 | Eager warm-up on `didOpen` | Low | High | Low |
| 2 | ReadyToRun publish | Very low | Low–Medium | None |
| 3 | Static WPF type database | Medium–High | High | Low |
| 4 | LSP progress notification | Low | UX only | None |
| 5 | Persist MSBuild cache | Medium | Medium | Medium |

Start with **Idea 1** (a few lines in the server) and **Idea 2** (a csproj flag).
Together they eliminate most of the perceived latency with minimal risk. **Idea 3**
is the long-term solution for instant completions regardless of project state.

# VS Code WPF Designer Integration — Design Specification

## Overview

This extension integrates the [WpfDesigner](https://github.com/icsharpcode/WpfDesigner) (XamlDesigner) into VS Code so that editing `.xaml` files has a fluent, round-trip visual design experience.

---

## Platform Support

**Windows only.** The extension declares `"os": ["win32"]` in `package.json`. VS Code and the Marketplace use this field to block installation on macOS and Linux. WPF and XamlDesigner.exe are Windows-only technologies, so no cross-platform support is planned.

---

## Goals

1. **Preview button** — When a `.xaml` file is open, show a "Preview in Designer" button in the editor title bar.
2. **Project awareness** — Before launching the designer, discover and build the associated .NET project so that custom types and styles resolve correctly.
3. **Round-trip editing** — The designer writes changes directly to disk; VS Code's file-system watcher picks them up automatically.
4. **Framework support** — Works for both .NET Framework (SDK-style `.csproj`) and modern .NET (`.NET 5+`) projects. Legacy non-SDK projects fall back to `msbuild`.
5. **Project/solution selection** — When project context is ambiguous, show a quick-pick UI. Suppress this UI when the **C# Dev Kit** extension is detected (it already manages solution context).
6. **Status bar item** — Always shows the currently selected project and allows switching.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  VS Code Extension (TypeScript)                         │
│                                                         │
│  extension.ts          — activation, command wiring     │
│  projectDiscovery.ts   — find .csproj/.sln, detect Kits │
│  designerLauncher.ts   — build project, spawn designer  │
│  statusBar.ts          — status bar item                │
└───────────────────┬─────────────────────────────────────┘
                    │  child_process.spawn()
                    ▼
┌─────────────────────────────────────────────────────────┐
│  XamlDesigner.exe  (pre-built, lives in tools/)         │
│  (from external/WpfDesigner/XamlDesigner)               │
│                                                         │
│  CLI:  XamlDesigner.exe <file.xaml> [assembly.dll ...]  │
│  — Opens the XAML file for visual editing               │
│  — DLL arguments are loaded into the Toolbox            │
│  — Saves back to the original file on disk              │
└─────────────────────────────────────────────────────────┘
```

---

## Components

### 1. XamlDesigner Binary (`tools/XamlDesigner/`)

The existing `external/WpfDesigner/XamlDesigner` project is a fully functional standalone WPF XAML designer that already accepts:

```
XamlDesigner.exe  path/to/File.xaml  [path/to/assembly1.dll  ...]
```

- `.xaml` arguments are opened as documents.
- `.dll`/`.exe` arguments are loaded into the Toolbox for type resolution.

A build script (`scripts/build-designer.ps1`) compiles the submodule and copies binaries to `tools/XamlDesigner/`. The `tools/` directory is committed or included in the VSIX package.

### 2. Project Discovery (`src/projectDiscovery.ts`)

**Exported API:**

```typescript
isWpfXaml(xamlPath: string): boolean
isWpfProject(projectPath: string): boolean
findProjectForFile(xamlPath: string): Promise<string | null>
findProjectsInWorkspace(): Promise<string[]>
findSolutionsInWorkspace(): Promise<string[]>
isCSharpDevKitInstalled(): boolean
getOutputAssemblies(projectPath: string): string[]
```

**WPF variant detection:**

The extension exclusively supports WPF. Two guards enforce this:

`isWpfXaml(xamlPath)` — reads the first 4 KB of the file and inspects namespace declarations:

| Signal | Verdict |
|---|---|
| `xmlns="https://github.com/avaloniaui"` or `avaloniaui.net` | Rejected (Avalonia) |
| `xmlns:x="using:..."` syntax | Rejected (UWP / WinUI / Uno) |
| `xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"` | Accepted (WPF) |
| Anything else | Rejected |

`isWpfProject(projectPath)` — reads the `.csproj` and applies:

| Signal | Verdict |
|---|---|
| `PackageReference Include="Avalonia"` | Rejected |
| `PackageReference Include="Uno.WinUI"` / `Uno.UI"` | Rejected |
| `PackageReference Include="Microsoft.WindowsAppSDK"` | Rejected |
| `<TargetPlatformIdentifier>UAP</TargetPlatformIdentifier>` | Rejected (UWP) |
| SDK-style + `<UseWPF>true</UseWPF>` | Accepted |
| Legacy + WPF type GUID `{60DC8134-…}` or `PresentationFramework` reference | Accepted |
| SDK-style without `<UseWPF>true</UseWPF>` | Rejected |

Both `findProjectForFile` and `findProjectsInWorkspace` call `isWpfProject` and silently skip non-WPF `.csproj` files, so the project picker never surfaces them.

**Algorithm for `findProjectForFile`:**

1. Start at the directory containing the `.xaml` file.
2. Walk up the directory tree looking for a `.csproj` file in the same folder.
3. Skip any `.csproj` that fails `isWpfProject()`.
4. Stop at the workspace root.
5. If no WPF project found, fall back to `findProjectsInWorkspace()` and prompt.

**Algorithm for `getOutputAssemblies`:**

1. Parse the `.csproj` XML to extract `<TargetFramework(s)>` and `<OutputPath>` (or `<AssemblyName>`).
2. Default output path: `bin/Debug/<targetFramework>/`.
3. Return all `.dll` files found in that directory after a successful build.

### 3. Designer Launcher (`src/designerLauncher.ts`)

**Exported API:**

```typescript
buildProject(projectPath: string, token: vscode.CancellationToken): Promise<BuildResult>
launchDesigner(xamlPath: string, assemblies: string[], context: vscode.ExtensionContext): child_process.ChildProcess
getDesignerExecutable(context: vscode.ExtensionContext): string | null
```

**Build step:**

- Run `dotnet build <project> --configuration Debug` via `child_process.spawn`.
- Capture stdout/stderr to an output channel ("WPF Designer").
- For non-SDK (legacy) `.csproj`, fall back to `msbuild.exe /t:Build`.
- On failure, show an error notification with a link to the output channel.

**Launch step — persistent designer session:**

One designer process is kept alive **per project**. This avoids the startup overhead on every preview request.

1. On first preview for a project:
   - Generate a unique named pipe name: `XamlDesigner-<timestamp>`.
   - Spawn `XamlDesigner.exe --pipe <pipeName> <file.xaml> [assemblies…]` detached.
   - Store `{ proc, pipeName }` in `activeDesigners` keyed by project path.
2. On subsequent previews for the same project (designer already running):
   - Connect to `\\.\pipe\<pipeName>` via `net.createConnection`.
   - Write the XAML file path as a newline-terminated string.
   - The designer opens/activates the file and brings its window to the foreground.
3. When the designer process exits, the session is removed and the next preview re-launches it.

**XamlDesigner pipe server (`App.xaml.cs`):**

- Parses `--pipe <name>` from command-line args and strips it before passing args to `ProcessPaths`.
- Starts a background thread (`IsBackground = true`) running `RunPipeServer(pipeName)`.
- The loop creates a `NamedPipeServerStream` (`PipeOptions.CurrentUserOnly`), waits for a connection, reads one line (the file path), then dispatches `Shell.Instance.Open(path)` + `MainWindow.Activate()` on the UI thread, and loops to accept the next connection.

### 4. Status Bar (`src/statusBar.ts`)

- Shown whenever a `.xaml` file is active.
- Displays: `$(tools) WPF: <ProjectName>` or `$(tools) WPF: (no project)`.
- Clicking it runs `wpf.selectProject`.
- Hidden when C# Dev Kit is installed and a project is auto-detected (reduces clutter).

### 5. Extension Entry (`src/extension.ts`)

**Commands registered:**

| Command ID              | Title                          | When visible                        |
|-------------------------|--------------------------------|-------------------------------------|
| `wpf.previewXaml`       | WPF: Preview in Designer       | Editor title bar, `.xaml` files     |
| `wpf.selectProject`     | WPF: Select Project            | Command palette                     |
| `wpf.buildDesignerTools`| WPF: Build Designer Tools      | Command palette                     |

**`wpf.previewXaml` flow:**

```
0. isWpfXaml() — reject with error if namespace is not WPF (Avalonia / UWP / WinUI / Uno).
1. Resolve the XAML file URI (from arg or active editor).
2. Look up cached project selection for this workspace folder.
3. If no project cached:
   a. Run findProjectForFile() — only returns WPF .csproj files.
   b. If ambiguous and C# Dev Kit NOT installed → showProjectPicker() — only lists WPF projects.
   c. Cache the selection in workspaceState.
4. isWpfProject() — reject with error if the resolved project is not a WPF project.
5. Check TFM compatibility between project and designer; offer rebuild if needed.
6. Show progress notification: "Building <project>…"
7. Run buildProject(). On failure → show error, abort.
8. Collect output assemblies.
9. Check designer executable exists; if not → offer to run buildDesignerTools.
10. launchDesigner(xamlPath, assemblies).
```

---

## File Structure

```
vscode-wpf/
├── src/
│   ├── extension.ts          ← main activation + command wiring
│   ├── projectDiscovery.ts   ← project/solution detection
│   ├── designerLauncher.ts   ← build + spawn designer
│   └── statusBar.ts          ← status bar item
├── tools/
│   └── XamlDesigner/         ← pre-built designer binaries (VSIX-included)
│       └── XamlDesigner.exe
├── scripts/
│   └── build-designer.ps1    ← builds WpfDesigner submodule → tools/
├── external/
│   └── WpfDesigner/          ← submodule (source only, not in VSIX)
└── sample/                   ← sample WPF project for manual testing
```

---

## `package.json` Additions

### Commands

```json
{ "command": "wpf.previewXaml",        "title": "WPF: Preview in Designer", "icon": "$(open-preview)" },
{ "command": "wpf.selectProject",       "title": "WPF: Select Project" },
{ "command": "wpf.buildDesignerTools",  "title": "WPF: Build Designer Tools" }
```

### Menus

```json
"editor/title": [
  { "command": "wpf.previewXaml", "when": "resourceExtname == .xaml", "group": "navigation" }
]
```

### Configuration

```json
"wpf.designerExecutable": {
  "type": "string",
  "description": "Override path to XamlDesigner.exe."
},
"wpf.dotnetPath": {
  "type": "string",
  "default": "dotnet",
  "description": "Path to the dotnet CLI executable."
},
"wpf.autoBuildOnPreview": {
  "type": "boolean",
  "default": true,
  "description": "Automatically build the project before launching the designer."
},
"wpf.buildConfiguration": {
  "type": "string",
  "default": "Debug",
  "description": "MSBuild configuration used when building the project."
}
```

---

## C# Dev Kit Integration

Detection:

```typescript
vscode.extensions.getExtension('ms-dotnettools.csdevkit') !== undefined
```

When installed:

- The status bar item is hidden (C# Dev Kit already shows a solution/project picker).
- Project auto-detection still runs, but the user is not prompted if a project is found.
- If project discovery fails entirely, fall back to showing our own quick-pick.

---

## Round-Trip File Editing

VS Code automatically reloads editor contents when the underlying file changes on disk (default behaviour with `files.autoSave` irrelevant — the **disk** file is the source of truth). No additional file watching is needed in the extension for this use case.

---

## Build Script (`scripts/build-designer.ps1`)

```
1. dotnet build external/WpfDesigner/XamlDesigner/Demo.XamlDesigner.csproj
              --configuration Release
              --output tools/XamlDesigner
2. Print success/failure summary.
```

Run via: `npm run build-designer` (added to `package.json` scripts).

---

## `.vscodeignore` Changes

Add:

```
external/**        ← submodule source not needed in VSIX
scripts/**         ← build scripts not needed
```

Do NOT ignore `tools/**` — the pre-built designer binaries must be included.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| XAML file is not WPF (Avalonia / UWP / WinUI / Uno) | Error notification; abort immediately |
| Resolved project is not a WPF project | Error notification naming the project; abort |
| Designer binary not found | Error notification with "Run Build Designer Tools" button |
| `dotnet build` fails | Error notification with "Show Output" button |
| No WPF project found for XAML file | Warning notification; open project picker (WPF-only) |
| Designer process crashes | Detected via `child_process` `exit` event; show error notification |
| Multiple WPF `.csproj` in workspace | Show quick-pick unless C# Dev Kit is installed and auto-detected |

---

---

## Language Server (`src/XamlLanguageServer.Wpf/`)

A WPF XAML language server built by adapting the [XamlToCSharpGenerator (AXSG)](https://github.com/wieslawsoltes/XamlToCSharpGenerator) infrastructure (submodule at `external/XamlToCSharpGenerator`).

### Architecture

```
VS Code extension (TypeScript)
  └─ vscode-languageclient  ──stdio──►  wpf-xaml-ls.exe
                                              │
                                    XamlLanguageServiceEngine
                                    (AXSG, WpfFrameworkProfile)
                                              │
                              ┌───────────────┴───────────────┐
                              │  XamlCompilerAnalysisService   │
                              │  (parse → bind → diagnostics)  │
                              └───────────────────────────────┘
                                              │
                                    20+ LSP analysis services
                                    (completions, hover, go-to-def,
                                     semantic tokens, rename, …)
```

### AXSG reuse strategy

AXSG defines a pluggable `IXamlFrameworkProfile` interface. The Avalonia adaptation (`XamlToCSharpGenerator.Avalonia`) implements it for Avalonia. `XamlLanguageServer.Wpf` implements the same interface for WPF:

| Interface | WPF implementation | Notes |
|---|---|---|
| `IXamlFrameworkProfile` | `WpfFrameworkProfile` | Singleton, assembles the other pieces |
| `IXamlFrameworkBuildContract` | `WpfFrameworkBuildContract` | `Page` / `ApplicationDefinition` item groups |
| `IXamlFrameworkTransformProvider` | `WpfFrameworkTransformProvider` | No-op — WPF has no transform rule files |
| `IXamlFrameworkSemanticBinder` | `WpfSemanticBinder` | Phase 1: stub; Phase 2: full `XmlnsDefinitionAttribute` resolution |
| `IXamlFrameworkEmitter` | `WpfCodeEmitter` | Stub — WPF codegen is handled by MSBuild targets |

`XamlLanguageServiceEngine` was extended with a `(ICompilationProvider, IXamlFrameworkProfile)` constructor overload (contributed back into the AXSG submodule) so any profile can be injected without changing the rest of the engine.

### WPF namespace conventions recognised

| URI | Prefix | Source |
|---|---|---|
| `http://schemas.microsoft.com/winfx/2006/xaml/presentation` | *(default)* | PresentationFramework |
| `http://schemas.microsoft.com/winfx/2006/xaml` | `x:` | XAML language |
| `http://schemas.microsoft.com/expression/blend/2008` | `d:` | Blend design-time |
| `http://schemas.openxmlformats.org/markup-compatibility/2006` | `mc:` | Markup compatibility |
| `clr-namespace:…` | any | Custom CLR types |

### Output location

Built by a future `build-language-server` script alongside the designer build, output to `tools/XamlLanguageServer/wpf-xaml-ls.exe`. The extension starts it on activation via stdio transport (silent no-op if binary not yet built).

### Phase roadmap

| Phase | Scope |
|---|---|
| **1 (current)** | XML parse errors, namespace validation, folding, formatting, document symbols |
| **2** | Full `XmlnsDefinitionAttribute` scanning → type completions, hover, go-to-definition, semantic tokens |
| **3** | Hot-reload bridge: push edits from the language server to the running WPF designer via the named pipe session |
| **4** | Visual designer integration: design-time property mutations reflected back in XAML |

---

## Future Considerations

- **XAML Hot Reload**: Bridge Phase 3 — language server pushes XAML text changes to the running XamlDesigner process via the named pipe, enabling live preview without explicit save.
- **Visual designer round-trip**: Designer property edits update the XAML document in VS Code; language server re-analyses in real time.

---

## WPF Hot Reload Strategy

### Core approach

WPF hot reload in this extension should use a **hybrid model**, not a pure language-server model and not a rebuild-on-every-edit model.

The designer will continue to load the **last known good compiled project artifacts** for:

- custom controls
- converters
- markup extensions
- attached properties
- design-time metadata
- referenced project and NuGet assemblies

The language server becomes the **control plane** that decides:

- which project/file the preview belongs to
- whether the current XAML is valid enough to apply live
- whether a rebuild is required before the next preview update
- whether the designer can stay on the current assembly set and receive only XAML text changes

This keeps WPF type fidelity while still allowing fast live updates for ordinary XAML edits.

### Why not language-server-only

The language server can resolve project context, diagnostics, and symbol information, but it cannot replace the runtime/type-loading role of compiled assemblies inside the WPF designer host.

The XamlDesigner process needs real CLR types and metadata to:

- instantiate custom controls
- resolve referenced assemblies
- apply resources and styles
- inspect design-time properties
- support drag/drop and property editing against real object instances

Therefore, compiled outputs remain required as the **assembly baseline** for preview.

### Session model

The preview pipeline should maintain one long-lived designer session per project.

Each session has:

- `projectPath`
- `pipeName`
- `designerProcess`
- `baselineAssemblySet`
- `baselineBuildStamp`
- `openXamlFiles`
- `lastKnownGoodXamlText` per document

The baseline assembly set is updated only after a successful build. Between builds, the language server may continue sending in-memory XAML updates to the running designer.

### Update flow

#### Initial preview

1. Resolve preview project via the language server.
2. Verify a usable baseline assembly set exists.
3. If not, build the project.
4. Launch the designer with the compiled assemblies.
5. Open the target XAML file in the running designer session.

#### Live XAML update

1. User edits XAML in VS Code.
2. Language server re-analyzes the in-memory document.
3. If the edit is XAML-only and diagnostics are acceptable:
   - send the current in-memory XAML text to the designer session
   - designer reloads the design surface from text without requiring a project rebuild
4. If the edit is not safe to apply live:
   - keep the designer on the last known good state
   - surface diagnostics in VS Code

#### Rebuild-required update

1. A change affects compiled type shape or assembly output.
2. Mark the preview session as requiring rebuild.
3. On the next preview refresh:
   - build the project
   - update the baseline assembly set
   - ask the designer to reload against the new baseline

### Decision matrix

| Change type | Rebuild required | Live update allowed | Notes |
|---|---|---|---|
| Text/property/layout changes in `.xaml` | No | Yes | Preferred hot path |
| Resource value changes in same XAML document | Usually no | Yes | Safe if no new CLR type dependency is introduced |
| Adding/removing controls already available in loaded assemblies | No | Yes | Standard live path |
| Changing namespace mappings to already-loaded assemblies | Usually no | Yes | Language server should validate first |
| Changing `x:Class` or root CLR type | Yes | No | Affects generated/runtime type relationship |
| Editing code-behind | Yes | No | Requires new assembly output |
| Editing custom control source | Yes | No | Designer needs rebuilt type |
| Editing converters / markup extensions / attached-property code | Yes | No | Requires rebuilt assembly |
| Editing project references / NuGet dependencies | Yes | No | Assembly closure changed |
| Changing build properties affecting generated output | Yes | No | Baseline must be replaced |

### Language server responsibilities

The language server should be extended from simple project-context lookup to explicit preview readiness evaluation.

Recommended custom request:

`axsg/preview/readiness`

Suggested response shape:

```json
{
  "projectPath": "C:\\repo\\sample\\sample.csproj",
  "filePath": "C:\\repo\\sample\\MainWindow.xaml",
  "canApplyLive": true,
  "requiresRebuild": false,
  "hasBlockingDiagnostics": false,
  "reason": null
}
```

The extension should use this request before deciding whether to:

- push live XAML text to the running designer
- reuse the current baseline assembly set
- perform a real build
- block preview and show diagnostics

### Designer transport changes

The current named-pipe transport only opens a file path in the running designer. It should be extended to support message kinds.

Recommended pipe commands:

- `openFile`
- `applyXamlText`
- `reloadFromDisk`
- `reloadAssemblies`
- `ping`

Suggested message envelope:

```json
{
  "command": "applyXamlText",
  "filePath": "C:\\repo\\sample\\MainWindow.xaml",
  "xamlText": "<Window ... />"
}
```

This avoids coupling hot reload to disk writes and allows the designer to preview unsaved editor content.

### Last-known-good behavior

The preview should never thrash or blank unnecessarily during normal editing.

Rules:

- if the current XAML text is temporarily invalid, keep rendering the last known good design surface
- continue surfacing diagnostics in VS Code
- resume live updates automatically once the document becomes valid again
- only replace the baseline assembly set after a successful build

This matches the best part of AXSG’s live tooling model: the editor can move through invalid intermediate states without destroying preview continuity.

### Implementation phases

#### Phase 3A — live XAML text push

- extend named-pipe protocol from `open file path` to structured commands
- add `applyXamlText` handling in XamlDesigner
- keep baseline assemblies fixed for the session
- update preview from unsaved XAML text when language server reports `canApplyLive = true`

#### Phase 3B — readiness-based rebuild gating

- add `axsg/preview/readiness`
- classify edits into `live`, `blocked`, or `rebuild-required`
- stop rebuilding on every preview request
- rebuild only when readiness says the assembly baseline is stale

#### Phase 3C — designer-originated round trip

- when designer changes properties/elements, emit structured mutation or full XAML text back to the extension
- update the VS Code document without forcing manual save/reopen cycles
- trigger language-server reanalysis immediately after designer mutations

### Success criteria

- Reopening preview for plain XAML edits does not rebuild the project.
- Unsaved XAML edits can appear in the running designer.
- Invalid intermediate edits do not destroy the current preview.
- Code-behind and custom-control changes correctly force rebuild before preview refresh.
- The language server is the single authority for preview project context and preview readiness.

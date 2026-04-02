# VS Code WPF Designer Integration — Design Specification

## Overview

This extension integrates the [WpfDesigner](https://github.com/icsharpcode/WpfDesigner) (XamlDesigner) into VS Code so that editing `.xaml` files has a fluent, round-trip visual design experience.

## Latest Status (March 31, 2026)

Runtime hot reload is now **runtime-first, push-based, and debugger-free**. The WPF app is launched as a regular child process — VS Code does **not** enter debugging mode.

1. Click `WPF: Hot Reload` once to launch the real WPF app (as a plain process, not a debug target).
2. The app shows an **in-app overlay toolbar** indicating Hot Reload is connected.
3. Edit XAML in VS Code.
4. Click `WPF: Hot Reload` again to push the current snapshot into the running app.

### Implemented architecture updates

- **Direct process launch** via `child_process.spawn()` — no VS Code debug session, no debug toolbar/sidebar.
- Added a dedicated command/action: `WPF: Hot Reload` (kept `WPF: Launch Designer` as fallback).
- Added startup-hook injection:
  - `DOTNET_STARTUP_HOOKS` points to `WpfHotReload.Runtime.dll`.
  - `WPF_HOTRELOAD_PIPE` carries a per-session named pipe.
- Runtime helper starts from startup hook and exposes a named-pipe command channel.
- Named pipe is the **only** runtime communication channel (no DAP/debugger fallback needed).
- Runtime hot reload is **manual push**, not auto-apply-on-edit.
- **In-app overlay toolbar** injected by the runtime helper shows Hot Reload status inside the WPF app.
- Added protocol message kind `preview` (MVP action: `capture`) returning PNG snapshots from the running WPF app.

### Important reliability fixes completed

- Removed dependency on debugger expression evaluation — startup hook + named pipe is fully self-contained.
- Removed startup-hook behavior that touched WPF from unsafe startup-thread polling.
- Added runtime pipe readiness probing (`agent.ready`) before first apply.
- Added parse diagnostics with exception type + inner exception text.
- Added safe XML property-update fallback for common edits (e.g., `Background`, `Text`, `Margin`, `SelectedIndex`) to avoid parser-driven first-chance exception stalls.

### Current behavior summary

- The app is launched as a regular child process (not a debug target).
- VS Code stays in normal editing mode — no debug UI is shown.
- The running WPF app displays a small overlay toolbar indicating Hot Reload status.
- Hot reload applies when the user explicitly pushes.
- The `WPF Hot Reload` output channel shows session lifecycle and apply results.
- WpfDesigner remains available as an optional backup path.

### Remaining known gaps

- Full structural XAML mutation still depends on parser/object-graph reconstruction and can fail on complex markup patterns.
- Visual Studio-level parity (all edit shapes, perfect state retention, full EnC-style behavior) is not complete yet.
- More end-to-end automation and richer live-instance mapping are still desirable.
- Optional "dev server" process (like Uno/MAUI) for more robust lifecycle management is a future enhancement.

---

## Platform Support

**Windows only.** The extension declares `"os": ["win32"]` in `package.json`. VS Code and the Marketplace use this field to block installation on macOS and Linux. WPF and XamlDesigner.exe are Windows-only technologies, so no cross-platform support is planned.

---

## Goals

1. **Launch Designer button** — When a `.xaml` file is open, show a "Launch Designer" button in the editor title bar.
2. **Project awareness** — Before launching the designer, discover and build the associated .NET project so that custom types and styles resolve correctly.
3. **Round-trip editing** — The designer writes changes directly to disk; VS Code's file-system watcher picks them up automatically.
4. **Framework support** — Works for both .NET Framework (SDK-style `.csproj`) and modern .NET (`.NET 5+`) projects. Legacy non-SDK projects fall back to `msbuild`.
5. **Project/solution selection** — When project context is ambiguous, show a quick-pick UI. Suppress this UI when the **C# Dev Kit** extension is detected (it already manages solution context).
6. **Status bar item** — Always shows the currently selected project and allows switching.
7. **Toolbox drag/drop in VS Code** — Allow WPF controls from a VS Code pane to be dragged into an active `.xaml` editor tab and inserted as valid XAML snippets.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  VS Code Extension (TypeScript)                              │
│                                                              │
│  extension.ts            — activation, command wiring        │
│  runtimeHotReload.ts     — hot reload session + pipe comms   │
│  projectDiscovery.ts     — find .csproj/.sln, detect Kits   │
│  designerLauncher.ts     — build project, spawn designer     │
│  statusBar.ts            — status bar item                   │
└──────┬──────────────────────────────┬────────────────────────┘
       │  child_process.spawn()       │  child_process.spawn()
       │  (Hot Reload path)           │  (Designer path)
       ▼                              ▼
┌────────────────────────────┐  ┌──────────────────────────────┐
│  User's WPF App (.exe)     │  │  XamlDesigner.exe            │
│                            │  │  (pre-built, lives in tools/)│
│  Env vars set at launch:   │  │                              │
│  · DOTNET_STARTUP_HOOKS    │  │  CLI: XamlDesigner.exe       │
│    → WpfHotReload.Runtime  │  │       <file.xaml> [dlls...]  │
│  · WPF_HOTRELOAD_PIPE      │  │  — Visual XAML editing       │
│    → named pipe name       │  │  — Saves back to disk        │
│                            │  └──────────────────────────────┘
│  ┌──────────────────────┐  │
│  │ WpfHotReload.Runtime │  │
│  │ (injected via hook)  │  │
│  │                      │  │
│  │ · Named pipe server  │  │
│  │ · XAML apply engine  │  │
│  │ · Overlay toolbar UI │  │
│  └──────────┬───────────┘  │
│             │ Dispatcher    │
│             ▼               │
│  ┌──────────────────────┐  │
│  │ Live WPF UI          │  │
│  │ (real app + overlay) │  │
│  └──────────────────────┘  │
└────────────────────────────┘
       ▲
       │  Named pipe (JSON lines)
       │  \\.\pipe\wpf-hotreload-{UUID}
       │
  Extension sends:
  · { filePath, xamlText }  → apply XAML
  · { kind: "query" }      → probe readiness
```

**Note:** VS Code does **not** enter debugging mode for hot reload. The WPF app is a plain child process. SharpDbg is available separately if the user wants actual debugging, but it is not part of the hot reload flow.

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

One designer process is kept alive **per project**. This avoids the startup overhead on every designer launch request.

1. On first designer launch for a project:
   - Generate a unique named pipe name: `XamlDesigner-<timestamp>`.
   - Spawn `XamlDesigner.exe --pipe <pipeName> <file.xaml> [assemblies…]` detached.
   - Store `{ proc, pipeName }` in `activeDesigners` keyed by project path.
2. On subsequent designer launches for the same project (designer already running):
   - Connect to `\\.\pipe\<pipeName>` via `net.createConnection`.
   - Write the XAML file path as a newline-terminated string.
   - The designer opens/activates the file and brings its window to the foreground.
3. When the designer process exits, the session is removed and the next designer launch re-launches it.

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
| `wpf.hotReload`         | WPF: Hot Reload                | Editor title bar, `.xaml` files     |
| `wpf.launchDesigner`   | WPF: Launch Designer           | Editor title bar, `.xaml` files     |
| `wpf.selectProject`     | WPF: Select Project            | Command palette                     |
| `wpf.buildDesignerTools`| WPF: Build Designer Tools      | Command palette                     |

**`wpf.launchDesigner` flow:**

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

### 6. VS Code Toolbox Drag-and-Drop (New Design)

This adds AXSG-style authoring ergonomics to the WPF extension: users drag controls from a toolbox pane into the text editor and the extension inserts the corresponding XAML.

#### Scope

- Drag from a VS Code side pane (webview view) into an active `.xaml` text editor.
- Insert control markup at the drop position if available; otherwise insert at current cursor/selection.
- Ensure namespace declarations are present before insertion (for custom controls).
- Keep the feature text-editor-first; it does not depend on the standalone `XamlDesigner.exe` process.

#### Proposed VS Code pieces

1. **Toolbox View Provider**
   - Register `wpf.toolbox` via `vscode.window.registerWebviewViewProvider`.
   - Render grouped controls (Core, Layout, Content, Items, Shapes, Media, Custom).
   - Emit drag payloads using `DataTransfer` with MIME:
     - `application/vnd.vscode-wpf.toolbox-item+json`
     - fallback `text/plain`

2. **Drop Into Editor**
   - Register `DocumentDropEditProvider` for `{ language: 'xaml', scheme: 'file' }`.
   - Parse toolbox payload and return a `DocumentDropEdit` snippet.
   - Respect `dropPosition` when provided by VS Code.

3. **Snippet/Template Engine**
   - Map each toolbox item to a snippet template with tab-stops.
   - Examples:
     - `Button` -> `<Button Content="$1" />`
     - `Grid` -> `<Grid>\n\t$1\n</Grid>`
     - `TextBox` -> `<TextBox Text="$1" />`
   - For controls needing child content, produce paired tags by default.

4. **Namespace Injection Helper**
   - Before final edit, inspect root element namespaces.
   - If dropped type is in a CLR namespace not yet mapped, add `xmlns:local="clr-namespace:...;assembly=..."`.
   - Reuse language-service/project metadata where available to avoid incorrect assembly names.

#### Drag payload contract

```json
{
  "kind": "wpfToolboxItem",
  "displayName": "Button",
  "typeName": "System.Windows.Controls.Button",
  "xmlNamespace": "http://schemas.microsoft.com/winfx/2006/xaml/presentation",
  "requiresPrefix": false,
  "defaultSnippet": "<Button Content=\"$1\" />"
}
```

For custom/user controls:

```json
{
  "kind": "wpfToolboxItem",
  "displayName": "MyControl",
  "typeName": "MyCompany.App.Controls.MyControl",
  "clrNamespace": "MyCompany.App.Controls",
  "assemblyName": "MyCompany.App",
  "prefixHint": "local",
  "requiresPrefix": true,
  "defaultSnippet": "<local:MyControl />"
}
```

#### Insertion behavior rules

1. If the drop lands inside an existing tag attribute region, reject drop with a friendly message.
2. If the drop lands in element content, insert with surrounding indentation inferred from the line.
3. If there is an active selection, replace selection only when the drop target equals that selection range; otherwise insert at drop target.
4. Always return a snippet string so users can tab through placeholders immediately.
5. Keep undo atomic (single workspace edit per drop).

#### Interaction with existing hot reload flow

- After insertion, normal document change events already trigger:
  - language server reanalysis,
  - manual runtime push via `WPF: Hot Reload`.
- No extra hot reload transport is required for v1.

#### Initial implementation phases

1. **Phase T1**: Static built-in control list + drop insertion provider.
2. **Phase T2**: Namespace auto-injection for custom controls.
3. **Phase T3**: Dynamic toolbox population from project symbols (language server integration).
4. **Phase T4**: Optional bidirectional sync with visual designer selection (future).

#### Success criteria

- User can drag `Button` from toolbox pane to any open `.xaml` editor and get snippet insertion at drop point.
- Inserted markup is syntactically valid XAML and undoable in one step.
- Custom control drops automatically add missing `xmlns` prefixes when required.

---

### 7. Event Handler Generation (Designer → VS Code)

When the user double-clicks a control in the visual designer, the extension creates an event handler stub in the code-behind file and navigates VS Code to it.

#### Full flow

```
User double-clicks Button in XamlDesigner
        │
        ▼
MoveLogic.HandleDoubleClick()
  → IEventHandlerService.GetDefaultEvent(item)   // "Click"
  → IEventHandlerService.CreateEventHandler(prop)
        │
        ├─ Sets XAML attribute: Click="Button_Click"
        │  (saved to disk by designer auto-save)
        │
        └─ Sends callback pipe message to VS Code:
           { command:"createEventHandler", xamlPath, handlerName,
             eventName, eventArgType }
                │
                ▼
        VS Code extension (designerLauncher.ts callback server)
          → finds <File>.xaml.cs (code-behind)
          → inserts method stub if not already present
          → opens file, places cursor inside stub body
          → brings VS Code window to foreground
```

#### Callback pipe protocol

A second named pipe is used for **designer → VS Code** communication, separate from the existing inbound pipe.

**Launch arguments:**
```
XamlDesigner.exe --pipe <inbound-pipe> --callback <callback-pipe> <file.xaml> [dlls…]
```

**Callback message (JSON, sent by designer):**
```json
{
  "command": "createEventHandler",
  "xamlPath": "C:\\project\\MainWindow.xaml",
  "handlerName": "Button_Click",
  "eventName": "Click",
  "eventArgType": "System.Windows.RoutedEventArgs"
}
```

The designer connects as a **pipe client** to the callback pipe (VS Code is the server) and sends the JSON payload when an event handler is requested, then closes the connection.

#### IEventHandlerService implementation (`VsCodeEventHandlerService.cs`)

Registered per-document in `Document.UpdateDesign()` via `XamlLoadSettings.CustomServiceRegisterFunctions`.

- **`GetDefaultEvent(DesignItem)`** — uses `TypeDescriptor.GetDefaultEvent(item.ComponentType)` to look up the type's `[DefaultEvent]` attribute via reflection.
- **`CreateEventHandler(DesignItemProperty)`** — generates handler name (`<ElementName>_<EventName>`), sets the XAML attribute value via `eventProperty.SetValue(handlerName)` inside a change group (so it is undo-able), then sends the callback message.

#### Handler name generation

| XAML attribute | Handler name |
|---|---|
| `x:Name="okButton"` | `okButton_Click` |
| *(no name)* | `Button_Click` |
| *(no name, second Button)* | `Button_Click` (duplicate — VS Code navigates to existing stub) |

#### Code-behind stub insertion (`src/codeBehindWriter.ts`)

1. Derive code-behind path: `<file>.xaml` → `<file>.xaml.cs`.
2. If the method already exists, skip insertion and navigate to it.
3. Detect indentation style from existing file content.
4. Insert before the class closing `}`:
   ```csharp
   private void Button_Click(object sender, RoutedEventArgs e)
   {
       
   }
   ```
5. Map `eventArgType` to its short C# name (`System.Windows.RoutedEventArgs` → `RoutedEventArgs`).
6. Apply via `vscode.WorkspaceEdit` (one undo step).

---

## File Structure

```
vscode-wpf/
├── src/
│   ├── extension.ts            ← main activation + command wiring
│   ├── runtimeHotReload.ts     ← hot reload session, process launch, pipe communication
│   ├── projectDiscovery.ts     ← project/solution detection, launch target resolution
│   ├── designerLauncher.ts     ← build + spawn designer, callback pipe server
│   ├── codeBehindWriter.ts     ← event handler stub insertion into .xaml.cs files
│   ├── statusBar.ts            ← status bar item
│   └── WpfHotReload.Runtime/   ← .NET startup hook helper (injected into WPF app)
│       ├── StartupHook.cs      ← DOTNET_STARTUP_HOOKS entry point
│       └── WpfHotReloadAgent.cs← named pipe server, XAML apply engine, overlay toolbar
├── tools/
│   ├── XamlDesigner/           ← pre-built designer binaries (VSIX-included)
│   │   └── XamlDesigner.exe
│   └── WpfHotReload.Runtime/   ← built helper DLL (VSIX-included)
│       └── WpfHotReload.Runtime.dll
├── scripts/
│   └── build-designer.ps1      ← builds WpfDesigner submodule → tools/
├── external/
│   ├── WpfDesigner/            ← submodule (source only, not in VSIX)
│   └── SharpDbg/               ← submodule (optional, for separate debugging)
└── sample/                     ← sample WPF project for manual testing
```

---

## `package.json` Additions

### Commands

```json
{ "command": "wpf.hotReload",           "title": "WPF: Hot Reload",          "icon": "$(flame)" },
{ "command": "wpf.launchDesigner",     "title": "WPF: Launch Designer",     "icon": "$(open-preview)" },
{ "command": "wpf.selectProject",       "title": "WPF: Select Project" },
{ "command": "wpf.buildDesignerTools",  "title": "WPF: Build Designer Tools" }
```

### Menus

```json
"editor/title": [
  { "command": "wpf.launchDesigner", "when": "resourceExtname == .xaml", "group": "navigation" }
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
"wpf.autoBuildOnDesignerLaunch": {
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
2. Mark the designer session as requiring rebuild.
3. On the next designer refresh:
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

The language server should be extended from simple project-context lookup to explicit designer readiness evaluation.

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
- stop rebuilding on every designer launch request
- rebuild only when readiness says the assembly baseline is stale

#### Phase 3C — designer-originated round trip

- when designer changes properties/elements, emit structured mutation or full XAML text back to the extension
- update the VS Code document without forcing manual save/reopen cycles
- trigger language-server reanalysis immediately after designer mutations

### Success criteria

- Reopening the designer for plain XAML edits does not rebuild the project.
- Unsaved XAML edits can appear in the running designer.
- Invalid intermediate edits do not destroy the current designer session.
- Code-behind and custom-control changes correctly force rebuild before designer refresh.
- The language server is the single authority for designer project context and designer readiness.

---

## Proposed "Visual Studio-like" Hot Reload Design

### Positioning

The earlier strategy was still too designer-centric. The primary host should be the **actual WPF app**, not a separate visual designer process and not a VS Code debug session.

The system now follows the **Uno/MAUI dev-server model**: the IDE launches the app as a plain process, injects a runtime helper via startup hook, and communicates over a named pipe. VS Code stays in normal editing mode — no debug toolbar, no call stack panel, no debug sidebar.

That means the system distinguishes between:

- **runtime hot reload** against the real app (primary path, no debugger)
- **runtime inspection** of the live visual tree (future)
- **optional design fallback** when no app is running

Each imported component owns one job:

- **AXSG / XSG** owns semantic analysis, edit classification, and "is this safe to apply live?" decisions.
- **WpfHotReload.Runtime** (startup hook helper) owns the in-process named pipe listener, XAML apply engine, and in-app overlay toolbar.
- **The actual WPF app** owns rendering, layout, bindings, resources, and real runtime behavior.
- **WpfDesigner** becomes an optional fallback for design-time inspection or editing, not the primary live-preview host.
- **The VS Code extension** remains the orchestrator, session manager, and pipe client.
- **SharpDbg** is available as a separate opt-in debugging tool, decoupled from the hot reload flow.

### Recommended architecture

We should formalize three cooperating session types.

#### 1. Runtime session

Used for the normal hot reload experience.

Host:

- the user's actual WPF process
- launched via `child_process.spawn()` with startup hook env vars

Backed by:

- the real application state
- unsaved XAML text streamed from the editor via named pipe
- the `WpfHotReload.Runtime` helper assembly (injected via `DOTNET_STARTUP_HOOKS`)

Purpose:

- apply supported edits directly to the running app
- preserve real bindings/resources/control behavior
- show in-app overlay toolbar with hot reload status
- keep the last known good applied state when an edit is temporarily invalid

#### 2. Extension coordination session

Used by the extension as the source of truth around the workspace and hot reload state.

Owned by:

- the VS Code extension
- the WPF language server (when available)

Tracks:

- workspace/project context
- open XAML documents
- build baseline stamp
- child process lifecycle (pid, exit events)
- pipe name and readiness state
- current active runtime target
- last known good document text

Note: This session does **not** depend on a VS Code debug session. The extension manages the child process directly.

#### 3. Design fallback session

Used only when the user wants inspection/editing without launching the app, or when runtime hot reload is unavailable.

Host:

- `XamlDesigner.exe`

Purpose:

- backup design surface
- optional visual tree/property tooling
- manual design editing scenarios

This should be treated as a secondary path, not the default hot reload story.

### SharpDbg's role (optional, separate from hot reload)

SharpDbg is **no longer part of the hot reload path**. Hot reload uses direct process launch + startup hook + named pipe, with no debugger involved.

SharpDbg remains available as a **separate debugging tool** for users who want breakpoints, call stacks, and variable inspection. It can coexist with hot reload (a user could debug the app separately), but hot reload does not depend on it.

If future features need debugger-level inspection (e.g., live visual tree with object identity, runtime type resolution), SharpDbg could be reintroduced as an optional enhancement. But the core hot reload flow must always work without it.

### Why AXSG / XSG should be central

AXSG is the best place to make preview and hot reload decisions because it already owns the semantic pipeline.

For WPF, we should extend the current `axsg/preview/projectContext` idea into a richer set of requests that classify the edit rather than merely locating the project.

Recommended requests:

- `axsg/preview/projectContext`
- `axsg/preview/readiness`
- `axsg/hotreload/classifyEdit`
- `axsg/hotreload/mapDocument`

Suggested classification result:

```json
{
  "projectPath": "C:\\repo\\sample\\sample.csproj",
  "filePath": "C:\\repo\\sample\\MainWindow.xaml",
  "mode": "designLive",
  "requiresRebuild": false,
  "requiresRuntimeInstance": false,
  "hasBlockingDiagnostics": false,
  "candidateRootType": "sample.MainWindow",
  "reason": null
}
```

This gives the extension one stable decision source for:

- push text to the runtime helper
- defer update but keep preview
- require rebuild
- require runtime attach
- refuse apply and surface diagnostics

### Proposed hot reload modes

The product should expose explicit internal modes even if the UI keeps them mostly automatic.

| Mode | Backing host | Primary use |
|---|---|---|
| `runtimeHotReload` | WPF app (child process) + startup hook helper | Default path for applying supported edits to the real app |
| `runtimeInspect` | WPF app + startup hook helper | Live visual tree and object inspection (future) |
| `designFallback` | WpfDesigner | Secondary path when no runtime session exists |

This avoids two failure modes: trying to make a designer impersonate the actual app, and forcing the user into debug mode just for hot reload.

### Transport design

The named pipe is the **sole** runtime communication channel for hot reload. There is no DAP dependency.

#### Runtime control channel (named pipe)

Transport:

- `\\.\pipe\wpf-hotreload-{UUID}` — created by the startup hook helper inside the WPF app

Protocol:

- JSON lines over byte-mode named pipe (UTF-8, newline-delimited)
- One connection per request (server loops accepting new connections)

Commands:

- `applyXamlText` — push XAML text to be applied to the live UI
- `applyScopedPatch` — apply a targeted property/subtree update (future)
- `reloadResourceDictionary` — reload resource scope without full window replace (future)
- `enumerateRoots` — list live window/page instances (future)
- `resolveDocumentRoot` — map a XAML file to a live UI root (future)
- `getLiveVisualTree` — inspect the running visual tree (future)
- `query` — probe readiness (`agent.ready`) and element state
- `ping` — liveness check

Current request/response shapes:

```json
{ "kind": "preview", "action": "capture", "filePath": "C:\\repo\\sample\\MainWindow.xaml" }
```

```json
{
  "result": "ok",
  "value": "{\"pngBase64\":\"...\",\"width\":1280,\"height\":720,\"source\":\"runtime:MainWindow.xaml\"}"
}
```

#### Optional designer channel

Transport:

- separate named pipe (`XamlDesigner-<timestamp>`)

Commands:

- `openFile`
- `applyXamlText`
- `getVisualTree`
- `getSelection`
- `setProperty`
- `serializeDocument`


We should extend it incrementally, keeping the runtime-first architecture and avoiding a big-bang rewrite.

#### Core principles

- Treat the preview pane as a **design client** over the existing runtime pipe protocol.
- Keep AXSG/XSG as the source of truth for document mapping and safe edit classification.
- Prefer **targeted XAML text edits** over direct in-memory runtime-only state changes.
- Never require debugger attachment for core design interactions.

#### Current implementation status (March 31, 2026)

- D1 MVP is implemented:
- D2 initial bridge is implemented:
  - Clicking a selected preview element now attempts source reveal in XAML.
  - Mapping now tries `axsg/hotreload/mapDocument` first, then falls back to local heuristics (`x:Name`/`Name`, then element type tag).
- AXSG map results are now confidence-gated in the extension; low-confidence mappings are rejected in favor of fallback matching with a status hint.
- Reverse sync currently prefers named elements only and debounces cursor events to reduce noisy runtime traffic.
- Reverse sync now enforces ambiguity guards (`Name` uniqueness check in source + runtime ambiguity rejection) and shows throttled status hints when sync is skipped.
- D3 write MVP is now available for a safe subset:
  - Writes are ambiguity-safe (require unique element match) and keep XAML as source of truth.
  - Brush edits are normalized/validated conservatively before writing.
  - Per-control capability gating is enforced from runtime inspection (buttons disable for unsupported properties; extension revalidates on apply).
- D4 MVP is now implemented:
  - Drop point is resolved via runtime `preview.hitTest`, then translated into source-of-truth XAML insertion edits.
  - Container-aware placement rules are enforced for `Panel`, `ItemsControl`, and `ContentControl` families.
  - Custom-control namespace injection and prefix resolution are reused during insertion.
  - Optional `Auto Push Hot Reload` can push successful insertions immediately.
- D2 remains intentionally conservative for ambiguous trees:
  - `mapDocument`/fallback reveal is wired, but reverse sync prefers uniquely named elements to avoid incorrect jumps.

#### Phase D1 — Interactive selection overlay (preview-only, read path)

Goal: click in preview and identify the corresponding live element/XAML node.

Runtime protocol additions:

  - image dimensions
  - root id
  - optional element bounds map
- `preview.hitTest`
  - input: preview pixel coordinates, root id
  - output: element id, type, `x:Name`, bounds
- `preview.enumerateRoots`
  - output: current windows/pages eligible for capture

VS Code pane additions:

- Hover rectangle + click-to-select in the preview image
- Selection chip showing type/name
- Selection event published to extension host

Success gate:

- Clicking a visible control in preview reliably resolves a stable element identity.

#### Phase D2 — XAML node mapping + reveal (bridge to editor)

Goal: map selected runtime element back to XAML text location.

Extension/AXSG additions:

- `axsg/hotreload/mapDocument` used for runtime-element-to-XAML mapping
- fallback heuristics using `x:Name`, type, and nearest ancestor

Editor integration:

- active XAML cursor updates preview selection when mapping is unambiguous

Success gate:

- Bi-directional selection sync works for common controls/layout containers.

#### Phase D3 — Property editing (write path, safe subset)

Goal: edit common properties from preview and round-trip to XAML text.

Runtime protocol additions:

- `preview.inspectProperties` (safe editable subset + current values)
- `preview.setProperty` (temporary runtime apply for immediate feedback)

Extension behavior:

- property panel in webview (Text, Background, Foreground, Margin, Width/Height, alignment subset)
- writes persist by issuing **XAML text edits** in the editor document (not runtime-only mutation)
- hot reload push remains the mechanism to apply persisted changes to runtime

Safety rules:

- do not write when mapping is ambiguous
- do not overwrite unrelated attributes/order/comments
- preserve formatting via existing formatter/refactoring services where possible

Success gate:

- Editing safe properties from preview updates both runtime and source XAML predictably.

#### Phase D4 — Toolbox placement and drag semantics

Goal: place new controls visually while preserving valid XAML structure.

Protocol/engine additions:

- `preview.getPlacementTargets` (valid drop containers at point)
- `preview.insertElement` (returns canonical insertion intent, not final text)

Extension behavior:

- convert insertion intent to XAML text edits in document
- reuse existing toolbox snippets + namespace injection
- keep container-specific rules (Panel children, ContentControl content, ItemsControl items)

Success gate:

- Drag/place from toolbox into preview creates valid XAML in correct container.

#### Phase D5 — Advanced designer behaviors (optional)

- adorner handles for margin/size/alignment
- multi-select
- undo/redo synchronization between pane and editor
- optional fallback to WpfDesigner serialization for complex object graphs

#### Protocol versioning and compatibility

- Add `protocolVersion` in request/response envelopes.
- New commands must be additive and feature-probed (`query: capabilities`).
- Preview pane should gracefully degrade to image-only mode when interactive commands are unavailable.

#### Risks and mitigations

- **Identity drift after hot reload**: use stable ids (`x:Name`, generated path signatures), refresh mappings after each apply.
- **Round-trip formatting regressions**: route writes through text-edit layer + formatter, avoid raw full-document rewrites.
- **Ambiguous mapping**: require confidence thresholds; block writes when uncertain.
- **Performance**: throttle capture requests, coalesce interaction updates, cache last frame metadata.

#### Recommended implementation order (embedded designer track)

1. D1 interactive selection protocol and pane UX.
2. D2 selection-to-XAML mapping + reveal.
3. D3 safe property editor with source-of-truth text edits.
4. D4 visual placement and insertion semantics.
5. D5 advanced adorners and power-user behaviors.

### Runtime helper design (`WpfHotReload.Runtime`)

The runtime helper is injected into the WPF app via `DOTNET_STARTUP_HOOKS` — no debugger needed.

Responsibilities:

- **Named pipe server** — listen on `WPF_HOTRELOAD_PIPE` for commands from the extension
- **XAML apply engine** — parse incoming XAML, match to live UI roots, apply property/subtree updates on the Dispatcher thread
- **Live root registry** — hold a registry of live roots by type/x:Class/source file hint
- **In-app overlay toolbar** — show a floating UI indicator inside the WPF app with hot reload status (connected, applying, applied, error)
- **Safe dispatcher marshalling** — all UI mutations go through `Dispatcher.Invoke`
- **Subtree rebuild** — rebuild a subtree from XAML when the edit can be scoped locally
- **Resource dictionary reload** — reload resource dictionaries without replacing the whole window when possible
- **Structured results** — emit apply results (success/error) back to the extension over the pipe

### In-App Hot Reload Overlay Toolbar

The WPF app should display a small floating overlay toolbar when hot reload is active, similar to the overlays used by Uno Platform and .NET MAUI. This gives the user immediate visual feedback without needing to look at VS Code.

#### Appearance

- A small semi-transparent bar anchored to the **top center** of the main window.
- Default height: ~28px. Unobtrusive but visible.
- Contains: a status icon, a short status label, and a collapse/dismiss button.
- Uses a neutral dark theme (semi-transparent dark background, light text) to avoid clashing with the app's own theme.

#### States

| State | Icon | Label | Color |
|---|---|---|---|
| Connected / Idle | 🔥 | `Hot Reload` | Neutral (gray) |
| Applying | ⟳ | `Applying…` | Blue |
| Applied successfully | ✓ | `Updated` | Green (fades back to Idle after 2s) |
| Apply failed | ✗ | `Error` | Red (stays until next apply or dismiss) |
| Disconnected | ○ | `Disconnected` | Yellow/dim |

#### Behavior

- **Injected by the startup hook**: when `WpfHotReloadAgent` detects `Application.Current` and the main window, it creates the overlay on the Dispatcher thread.
- **Non-intrusive**: uses a WPF `Adorner` on the main window's root `AdornerLayer`, or a top-level `Popup` if the adorner layer is unavailable. The overlay does not modify the app's logical tree or interfere with layout.
- **Dismissible**: the user can collapse the toolbar to a minimal icon. The collapsed state persists for the session.
- **Updates on each apply**: the agent updates the overlay status from the pipe listener's apply result callback.
- **Auto-hides on disconnect**: if the pipe listener stops (extension disconnected, pipe broken), the overlay shows "Disconnected" briefly and then fades out.
- **Does not capture input**: the overlay should be hit-test transparent for mouse events on the app content below it, except for the collapse/dismiss button itself.

#### Implementation in `WpfHotReloadAgent`

The overlay is created and managed inside the runtime helper assembly. Rough structure:

```csharp
// Called once after Application.Current and MainWindow are available
void InjectOverlayToolbar(Window mainWindow)
{
    // Create a lightweight overlay UserControl or Border
    // Attach it as an Adorner on the window's root AdornerLayer
    // Expose UpdateStatus(OverlayState state, string message) for the pipe listener
}
```

The pipe listener calls `UpdateStatus()` after each apply operation:
- Before apply: `UpdateStatus(Applying, "Applying…")`
- On success: `UpdateStatus(Applied, "Updated")` → auto-revert to Idle after 2s
- On error: `UpdateStatus(Error, exceptionMessage)`

### WpfDesigner reuse opportunities

WpfDesigner is still valuable, but now as a secondary asset.

The most reusable pieces are likely:

- toolbox/type discovery
- property grid metadata
- visual tree / selection model
- XAML serialization for designer-originated edits

The less attractive path is trying to make WpfDesigner itself become the live app host. The user is right to avoid that. The real app should be the real app.

### Edit classification model

The extension should not ask "can I hot reload?" in a binary way. It should classify each edit into one of several buckets.

| Edit class | Target | Behavior |
|---|---|---|
| `xaml-text-safe` | Runtime | Apply immediately |
| `xaml-text-unsafe-temporary` | None | Keep last known good view, show diagnostics |
| `resource-only` | Runtime | Reload resource scope |
| `requires-subtree-rebuild` | Runtime helper | Recreate affected subtree |
| `requires-assembly-rebuild` | Build pipeline | Rebuild before next apply |
| `requires-process-restart` | Extension (relaunch app) | Notify user and offer restart |

This is closer to how users think about hot reload: sometimes it works instantly, sometimes it waits, sometimes it asks for rebuild, and sometimes it cannot continue.

### Mapping a XAML file to a runtime instance

This is the hardest problem and deserves an explicit design.

We should not rely on file path alone. Instead, mapping should use a chain of signals:

1. `x:Class` and root CLR type
2. compile item identity from the project system
3. runtime root type
4. currently open window/page instances
5. optional debug-time metadata injected by a helper assembly

If multiple runtime instances match, the extension should prefer:

- active/focused window
- most recently created window
- explicit picker as fallback

The runtime helper's live root registry is what enables this mapping without needing a debugger.

### Interaction with save/build/debug

The desired flow should be:

1. User edits XAML.
2. AXSG classifies the edit.
3. If `runtimeHotReload` is active and the edit is supported, the running app updates immediately.
4. If the edit crosses a rebuild boundary, the extension marks the session stale instead of eagerly rebuilding.
5. Save or explicit refresh can trigger a rebuild when needed.
6. If code-behind/custom type shape changed, the extension notifies the user that a rebuild and app relaunch is required.
7. If no runtime session exists, optional fallback tooling may offer designer-only inspection.

This keeps the common path fast while still being honest about WPF's real constraints.

### Recommended implementation order

The safest sequence is:

1. **Direct process launch** — replace `vscode.debug.startDebugging()` with `child_process.spawn()` so VS Code stays in normal editing mode. *(done)*
2. **Startup hook + named pipe** — inject `WpfHotReload.Runtime` via `DOTNET_STARTUP_HOOKS`, communicate over named pipe. *(done)*
3. **Runtime XAML patch application** for the safe subset. *(done)*
4. **In-app overlay toolbar** — show hot reload status inside the WPF app (like Uno/MAUI). *(next)*
5. Add **AXSG-driven edit classification** and stale-state tracking.
6. Add **visual tree inspection and selection mapping** from the live app.
7. Add **resource dictionary and subtree rebuild** support.
8. Optionally add a **dev server process** (like Uno's `dotnet-dsrouter`) for more robust lifecycle management.
9. Add **designer fallback** only after the runtime-first path is solid.

This order delivers user value early and avoids blocking on the hardest runtime problems before we have a solid design loop.

### Non-goals for v1

We should explicitly avoid overpromising.

Not a v1 goal:

- arbitrary code-behind hot reload
- reliable live mutation for every possible custom control pattern
- full BAML-compatible runtime patching
- rehosting all of Visual Studio's private WPF designer/debugger behavior
- requiring a debugger for hot reload

Instead, v1 should target:

- launching the real WPF app as a plain process (no debug mode)
- unsaved XAML updates into the real app via named pipe
- in-app overlay toolbar showing hot reload status
- last-known-good runtime continuity
- supported runtime XAML patching for common layout/property/resource edits
- clear fallback when rebuild or restart is necessary

### Decision

The best design is a **runtime-first, debugger-free model**:

- **the actual WPF app + startup hook helper + named pipe** for live hot reload
- **In-app overlay toolbar** for visual hot reload status (like Uno/MAUI)
- **AXSG** as the semantic control plane that decides which path is legal for each edit
- **WpfDesigner** only as an optional fallback or source of reusable inspection/editing pieces
- **SharpDbg** available separately for debugging, but decoupled from hot reload

VS Code stays in normal editing mode. The user sees hot reload status in the app itself, not in the debug toolbar.

---

## Historical Note: Debugger-Based Hot Reload (Superseded)

Early prototypes used SharpDbg to launch the WPF app as a VS Code debug target and applied XAML updates via debugger expression evaluation. This approach was unreliable because:

- Forced pauses often landed in unmanaged/native code with no usable managed IL frame
- `ApplyWpfHotReload(...)` would fail with `error: no stack frame available for evaluation`
- The approach was fundamentally dependent on "whatever stack frame happened to be active when the user clicked the button"

The solution was to **remove the debugger dependency entirely** for hot reload by using `DOTNET_STARTUP_HOOKS` to inject the runtime helper before `Main()` runs, and communicate over a named pipe. This is now the only hot reload path.

## DOTNET_STARTUP_HOOKS Injection Architecture (Implemented)

**How it works**

1. The extension builds the `WpfHotReload.Runtime` helper DLL and generates a unique pipe name (UUID-based).

2. The extension spawns the WPF app as a plain child process with two environment variables:
   - `DOTNET_STARTUP_HOOKS` → path to `WpfHotReload.Runtime.dll`
   - `WPF_HOTRELOAD_PIPE` → the generated pipe name

3. When the .NET runtime starts, it calls `StartupHook.Initialize()` from the helper assembly. This starts a background thread that polls for `Application.Current` to become available.

4. Once the WPF Application exists, the background thread:
   - Starts a `NamedPipeServerStream` listener using the pipe name from the env var.
   - Injects the in-app overlay toolbar into the main window.

5. When the user clicks Hot Reload, the extension connects to `\\.\pipe\{pipeName}`, sends a JSON line with `filePath` and `xamlText`, and reads back the result. The pipe listener dispatches to the UI thread via `Dispatcher.Invoke` for safe visual tree mutation.

**Why this works**

- No debugger needed. The helper is loaded by the runtime itself, before any application code runs.
- VS Code stays in normal editing mode — no debug toolbar, sidebar, or call stack.
- Thread creation happens in normal managed code (the startup hook's background thread).
- The pipe listener is ready before the user ever clicks Hot Reload, so there is no first-request delay.
- The pipe name is known to both sides because the extension generated it and passed it via env var.
- The in-app overlay toolbar gives the user immediate visual feedback inside the running app.

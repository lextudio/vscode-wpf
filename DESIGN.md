# VS Code WPF Designer Integration — Design Specification

## Overview

This extension integrates the [WpfDesigner](https://github.com/icsharpcode/WpfDesigner) (XamlDesigner) into VS Code so that editing `.xaml` files has a fluent, round-trip visual design experience.

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
findProjectForFile(xamlPath: string): Promise<string | null>
findProjectsInWorkspace(): Promise<ProjectInfo[]>
findSolutionsInWorkspace(): Promise<string[]>
isCSharpDevKitInstalled(): boolean
getOutputAssemblies(projectPath: string): Promise<string[]>
```

**Algorithm for `findProjectForFile`:**

1. Start at the directory containing the `.xaml` file.
2. Walk up the directory tree looking for a `.csproj` file in the same folder.
3. Stop at the workspace root.
4. If no single project found, fall back to `findProjectsInWorkspace()` and prompt.

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

**Launch step:**

- Resolve `XamlDesigner.exe` from:
  1. `wpf.designerExecutable` user setting (override).
  2. `<extensionPath>/tools/XamlDesigner/XamlDesigner.exe` (default).
- Spawn the process detached (designer lives independently of VS Code).
- Track the spawned PID to avoid double-launching for the same file.

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
1. Resolve the XAML file URI (from arg or active editor).
2. Look up cached project selection for this workspace folder.
3. If no project cached:
   a. Run findProjectForFile().
   b. If ambiguous and C# Dev Kit NOT installed → showProjectPicker().
   c. Cache the selection in workspaceState.
4. Show progress notification: "Building <project>…"
5. Run buildProject(). On failure → show error, abort.
6. Collect output assemblies.
7. Check designer executable exists; if not → offer to run buildDesignerTools.
8. launchDesigner(xamlPath, assemblies).
9. Show information message: "Designer launched for <file>."
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
| Designer binary not found | Error notification with "Run Build Designer Tools" button |
| `dotnet build` fails | Error notification with "Show Output" button |
| No project found for XAML file | Warning notification; open project picker |
| Designer process crashes | Detected via `child_process` `exit` event; show error notification |
| Multiple `.csproj` in workspace | Show quick-pick unless C# Dev Kit is installed and auto-detected |

---

## Future Considerations

- **Live XAML sync**: Add an optional file watcher that triggers a designer "Refresh" command via a named pipe or stdout protocol, enabling live preview without manual save.
- **XAML Hot Reload**: Investigate integrating with .NET Hot Reload for runtime preview.
- **Web-based preview**: A WebviewPanel-based fallback for non-Windows platforms using a WASM renderer.

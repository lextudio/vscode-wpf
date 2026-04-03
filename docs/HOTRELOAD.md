# WPF XAML Hot Reload — Design Document

## Overview

This document describes the architecture of vscode-wpf's XAML hot reload engine.
The engine runs as a two-part system: a VS Code extension side (TypeScript) that
detects file changes, computes diffs, and classifies edits; and an in-process
runtime agent (C#) injected into the running WPF app that applies changes using
WPF's diagnostic infrastructure.

Current launch model:

- Clicking `WPF: Hot Reload` launches the target app under the bundled `SharpDbg` debugger.
- The first click starts the debugged app and runtime agent; subsequent clicks push XAML updates.
- This keeps crash investigation available during hot reload sessions (breakpoints, call stack, locals).

## Background: WPF Diagnostic APIs

The open-source WPF repo exposes several diagnostic hooks that make XAML hot
reload possible without rebuilding the application:

### Source Mapping

- **`XamlSourceInfoHelper`** stores `{Uri, LineNumber, LinePosition}` for every
  object created during XAML/BAML loading, in a `ConditionalWeakTable<object,
  XamlSourceInfo>`.  Enabled by the `ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO`
  environment variable.  Uses "latest source wins" semantics — when a
  `UserControl` is created from its own XAML and then re-mapped to a parent
  window's XAML, the parent mapping replaces the child mapping.

- **`VisualDiagnostics.GetXamlSourceInfo(object)`** is the public API to read
  these mappings at runtime.

- **`WpfXamlLoader.AfterBeginInitHandler`** fires during XAML loading.  Each
  created object gets a `PersistId` (sequential integer) and source info recorded
  via `XamlSourceInfoHelper.SetXamlSourceInfo`.

### Visual Tree Tracking

- **`VisualDiagnostics.VisualTreeChanged`** fires on every `AddVisualChild` /
  `RemoveVisualChild` call.  Enabled by `ENABLE_XAML_DIAGNOSTICS_VISUAL_TREE_NOTIFICATIONS`
  or debugger-attached or Windows Dev Mode.

- **Re-entrancy guard**: Handlers must not modify the visual tree, resource
  dictionaries, or certain dependency properties while the event is firing.
  Changes should be queued to the Dispatcher.

### Resource Dictionary Diagnostics

- **`ResourceDictionaryDiagnostics.GetResourceDictionariesForSource(Uri)`**
  returns all live `ResourceDictionary` instances loaded from a given source URI.
  Internally tracked via `WeakReference<ResourceDictionary>` keyed by URI.

- **`ResourceDictionary.InvalidatesImplicitDataTemplateResources`** forces
  `ContentPresenter` to re-evaluate implicit `DataTemplate` choice when resources
  change.

### Template and Property Analysis

- **`DependencyPropertyHelper.IsTemplatedValueDynamic(element, dp)`** reports
  whether a template-provided value can change at runtime (Binding,
  TemplateBinding, DynamicResource).  Static values need explicit updates.

- **`XamlReader.Parse(string)`** creates an object graph from loose XAML,
  triggering `AfterBeginInitHandler` on each object — the same path used for
  compiled XAML.  This gives us fresh source maps for dynamically loaded content.

### Tree Walking

- **`VisualTreeHelper.GetChildrenCount / GetChild / GetParent`** — traverse the
  live visual tree to find elements by source info, name, or type.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  VS Code Extension (TypeScript)                  │
│                                                  │
│  File Watcher ──► XAML Diff Engine ──► Classifier│
│                                                  │
│  Classifier produces:                            │
│    ChangeKind = property | subtree | resource |  │
│                 fullFile | restart              │
│    PropertyChanges[] (for property-only edits)   │
│    AffectedRegion (for subtree replacement)      │
│                                                  │
│  Named Pipe Client  ──────────────────────────►  │
└──────────────────────────────────────────────────┘
                         │
                    JSON protocol
                         │
┌──────────────────────────────────────────────────┐
│  Runtime Agent (C# in-proc)                      │
│                                                  │
│  SourceMap: uri+line ──► WeakRef<object>          │
│  Built via VisualDiagnostics.GetXamlSourceInfo   │
│                                                  │
│  Pipe Listener receives change, dispatches:      │
│                                                  │
│  ┌─ Level 0: Property Patch                      │
│  │  Find element by source map or x:Name         │
│  │  Apply changed dependency property values     │
│  │                                               │
│  ├─ Level 1: Subtree Reload                      │
│  │  Parse new subtree via XamlReader.Parse        │
│  │  Match children by name/type/position         │
│  │  Swap subtree in parent container             │
│  │                                               │
│  ├─ Level 2: Resource Dictionary Reload          │
│  │  Use ResourceDictionaryDiagnostics to find    │
│  │  all live instances from the changed URI      │
│  │  Clear + re-populate each instance            │
│  │                                               │
│  ├─ Level 3: Full File Reload                    │
│  │  Re-parse entire XAML, replace root content   │
│  │  (current behavior, kept as fallback)         │
│  │                                               │
│  └─ Level 4: Restart Required                    │
│     New x:Class, event wiring, generic.xaml      │
│     Report to extension, user decides            │
└──────────────────────────────────────────────────┘
```

## Environment Setup

The extension sets these environment variables **before** launching the WPF app
through `SharpDbg`:

| Variable | Value | Purpose |
|---|---|---|
| `ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO` | `1` | Enable XamlSourceInfo tracking |
| `WPF_HOTRELOAD_PIPE` | `wpf-hotreload-{uuid}` | Named pipe for communication |
| `WPF_HOTRELOAD_LOG` | (optional path) | File logging for diagnostics |
| `WPF_HOTRELOAD_START_HIDDEN` | `0` or `1` | Hide host window on start |

Note: `ENABLE_XAML_DIAGNOSTICS_VISUAL_TREE_NOTIFICATIONS` is intentionally
**not** set by default.  The visual tree change event has re-entrancy restrictions
and is only needed for advanced scenarios (verification, live tree diffing).  The
engine can be extended to use it later.

## Named Pipe Protocol

All messages are single-line JSON, newline-terminated.

### Request: XAML Update (enhanced)

```json
{
  "filePath": "C:\\...\\MainWindow.xaml",
  "xamlText": "<Window ...>...</Window>",
  "changeKind": "property",
  "previousXamlText": "<Window ...>...</Window>",
  "propertyChanges": [
    {
      "elementName": "PrimaryButton",
      "elementType": "Button",
      "property": "Background",
      "newValue": "Green",
      "line": 15,
      "column": 8
    }
  ]
}
```

**`changeKind`** values:

| Kind | Description | Agent Behavior |
|---|---|---|
| `property` | Only attribute values changed on existing elements | Level 0: patch properties directly |
| `subtree` | Children added/removed/reordered within a container | Level 1: replace affected subtree |
| `resource` | ResourceDictionary file changed | Level 2: targeted resource reload |
| `fullFile` | Root element changed, or too complex to classify | Level 3: full re-parse and apply |
| `restart` | x:Class changed, new types, generic.xaml | Level 4: report restart needed |

**Backward compatibility**: If `changeKind` is absent, the agent falls back to
the current full-file reload behavior (Level 3).

### Request: Query

```json
{
  "kind": "query",
  "query": "agent.ready"
}
```

### Request: Preview

```json
{
  "kind": "preview",
  "action": "capture",
  "filePath": "..."
}
```

### Response

```json
{
  "result": "ok",
  "value": "...",
  "level": 0,
  "elementsUpdated": 3
}
```

## XAML Diff Engine (Extension Side)

The extension maintains the last-known XAML text per file. On save, it:

1. **Parses** both old and new XAML as XML documents.
2. **Compares** elements structurally:
   - Same element tag + same position + different attribute values → **property change**
   - Same parent, different child count or order → **subtree change**
   - Root element tag changed → **full file reload**
   - `x:Class` changed → **restart required**
3. **Extracts** a list of `PropertyChange` objects for property-only edits.
4. **Sends** the classified change to the runtime agent.

The diff engine does **not** need to be a full XML diff algorithm. It operates on
the assumption that most hot reload edits are small: a color change, a margin
tweak, a text update. The classification determines which apply strategy the
runtime agent uses, and the agent always has the full new XAML as a fallback.

## Source Map (Runtime Agent)

On first connection (or on demand), the agent builds a source map:

```csharp
Dictionary<SourceAnchor, WeakReference<DependencyObject>> sourceMap;

struct SourceAnchor {
    string Uri;       // normalized file path
    int Line;
    int Column;
}
```

Built by walking `Application.Current.Windows` and all descendants, calling
`VisualDiagnostics.GetXamlSourceInfo(obj)` for each.  Elements with no source
info (runtime-created, or Release builds) are skipped.

The map is **rebuilt** after each successful full-file reload or subtree
replacement (since source positions shift).  For property-only patches, the map
remains valid because line/column positions don't change.

## Escalation Strategy

The agent attempts the lowest-impact strategy first and escalates on failure:

```
property patch ──fail──► subtree reload ──fail──► full file reload ──fail──► report error
```

For resource dictionary files:
```
resource reload ──fail──► report error (no further escalation)
```

**Level 0 — Property Patch**:
- Find target element via source map (line/column) or `x:Name` lookup
- Use `TypeDescriptor.GetConverter` to convert string values
- Set dependency properties directly
- Fastest path, no object graph reconstruction, no first-chance exceptions

**Level 1 — Subtree Reload**:
- Parse affected subtree via `XamlReader.Parse`
- Match live children to parsed children by `x:Name`, then by type+position
- Apply in-place where possible (same type + same name)
- Replace where necessary (detach from parsed parent, attach to live parent)

**Level 2 — Resource Dictionary Reload**:
- Call `ResourceDictionaryDiagnostics.GetResourceDictionariesForSource(uri)` via
  reflection to find all live instances
- For each instance: clear, re-populate from parsed dictionary
- Set `InvalidatesImplicitDataTemplateResources = true` to force template re-evaluation

**Level 3 — Full File Reload**:
- Parse entire XAML with `XamlReader.Parse` (stripping `x:Class`, skipping events)
- Match live root by `x:Class` name or type
- Apply full object tree (current behavior)
- Rebuild source map afterward

**Level 4 — Restart Required**:
- Report to extension that the change cannot be applied live
- Extension shows notification to user

## Known Limitations

These cases are documented as unsupported or partial, matching Microsoft's own
XAML Hot Reload limitations:

- **New `x:Class`**: Adding new windows, pages, or user controls requires restart
- **Event wiring**: Adding new event handlers (e.g., `Click="OnClick"`) requires
  restart because the handler method must exist in the code-behind
- **`generic.xaml` / theme dictionaries**: Editing theme-level resources may
  require restart
- **Attached properties**: Changes to attached properties (e.g., `Grid.Row`) are
  supported in subtree reload but not in property-only patches (the XML fallback
  path skips dotted attribute names)
- **Binding expressions**: Changes from a static value to a `{Binding ...}` or
  vice versa require subtree reload (the property patch path uses
  `TypeDescriptor` which doesn't handle markup extensions)
- **Release builds**: Source info tracking requires debug builds with
  `ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1`

## Target Platforms

- **Phase 1 (current)**: .NET 6+ WPF apps (modern runtime, `DOTNET_STARTUP_HOOKS`)
- **Phase 2**: .NET Framework 4.6.2+ via `AppDomainManager` injection

Both phases share the same runtime agent code (multi-targeted).

## Files

| File | Role |
|---|---|
| `src/runtimeHotReload.ts` | Extension-side session management, diff engine, pipe client |
| `src/WpfHotReload.Runtime/WpfHotReloadAgent.cs` | In-process agent: pipe server, source map, apply strategies |
| `src/WpfHotReload.Runtime/StartupHook.cs` | .NET Core/5+ entry point |
| `src/WpfHotReload.Runtime/FrameworkStartupHook.cs` | .NET Framework entry point |

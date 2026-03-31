# .NET Framework WPF Hot Reload Support

## Status: IMPLEMENTED ✅

## Problem

The current XAML hot reload pipeline injects a helper DLL into the running WPF
app via `DOTNET_STARTUP_HOOKS`, a .NET Core/5+ only feature. .NET Framework
apps ignore this environment variable, so the named-pipe listener never starts
and hot reload silently fails.

## Key Insight

The actual reload logic in `WpfHotReloadAgent` — `XamlReader.Parse`,
`Application.Current`, `Dispatcher.Invoke`, named pipes, visual-tree walking —
is all standard WPF API that exists identically on .NET Framework. The only
gap is the **injection mechanism**: how to get the pipe listener running inside
the target process at startup.

## Solution: AppDomainManager

.NET Framework has its own startup-hook equivalent:
**`System.AppDomainManager`**. When the CLR starts, it checks two environment
variables:

- `APPDOMAIN_MANAGER_ASM` — assembly display name of the helper
- `APPDOMAIN_MANAGER_TYPE` — full type name of a class deriving from
  `System.AppDomainManager`

The runtime creates an instance and calls `InitializeNewDomain()` before the
app's `Main()` runs — the same contract as `DOTNET_STARTUP_HOOKS`.

## Implementation Plan

### 1. Multi-target `WpfHotReload.Runtime`

Change the project from `net10.0-windows` to:

```xml
<TargetFrameworks>net10.0-windows;net462</TargetFrameworks>
```

### 2. Replace `System.Text.Json`

`System.Text.Json` is not available on .NET Framework without a NuGet package.
Options:

- **Manual JSON** — the request/response objects are trivial (2-3 fields each),
  so hand-rolled parse/serialize is viable and avoids any new dependency.
- Guard with `#if` so .NET Core builds keep using `System.Text.Json`.

### 3. Add `AppDomainManager` entry point

Create a new class (e.g. `FrameworkStartupHook`) that derives from
`AppDomainManager` and calls `WpfHotReloadAgent.EnsurePipeListenerStarted()`
from `InitializeNewDomain()`, mirroring what `StartupHook.Initialize()` does.

### 4. Update the TypeScript side

In `startRuntimeHotReloadSession`:

- Detect whether the project targets .NET Framework (already done via
  `parseProject`).
- For Framework projects, set `APPDOMAIN_MANAGER_ASM` and
  `APPDOMAIN_MANAGER_TYPE` instead of `DOTNET_STARTUP_HOOKS`.
- Point to the `net462` build of the helper DLL.

In `ensureRuntimeHelperBuilt`:

- Build both TFMs (or just the one needed).
- Return the correct DLL path based on the project's target framework.

### 5. Integration test

Extend the existing `frameworkHotReload.integration.ts` to launch the net462
sample, connect via the named pipe, push a XAML change, and verify the update
applied — the same flow as the .NET Core test.

## Risks and Limitations

- `AppDomainManager` requires the helper assembly to be loadable by the CLR.
  The DLL must be on the probing path or in the GAC. Placing it next to the
  target exe (via file copy or `DEVPATH`) is the simplest approach; setting
  `APPDOMAIN_MANAGER_ASM` to a full path is not supported, so we may need to
  add the helper's directory to the `DEVPATH` or `PRIVATEPATH` environment
  variable.
- Some corporate environments restrict `AppDomainManager` via CAS policy,
  though this is rare in development scenarios.
- .NET Framework 4.6.2 is the minimum — older versions may have quirks with
  `AppDomainManager` but are unlikely targets for active WPF development.

## Implementation Notes

### C# Changes

1. **Multi-targeting**: `WpfHotReload.Runtime.csproj` now targets both
   `net10.0-windows` and `net462`.

2. **System.Text.Json compatibility**: Replaced with manual JSON parsing for
   `net462` target using simple string manipulation. Added conditional compilation:
   ```csharp
   #if NETFRAMEWORK
   // Manual JSON parsing
   #else
   // System.Text.Json
   #endif
   ```

3. **API compatibility**:
   - Replaced `Environment.ProcessId` with `Process.GetCurrentProcess().Id`
   - Replaced array slicing syntax (`line[..100]`) with `Substring()`
   - Added `System.ValueTuple` NuGet reference for tuple support on Framework

4. **FrameworkStartupHook class**: New `AppDomainManager` subclass that calls
   `WpfHotReloadAgent.EnsurePipeListenerStarted()` from `InitializeNewDomain()`.

### TypeScript Changes

1. **Project detection**: `parseProject()` now reads `<TargetFrameworkVersion>`
   from legacy csproj files and converts to TFM moniker (e.g., `v4.6.2` → `net462`).

2. **Dual injection paths**: `startRuntimeHotReloadSession()` detects Framework
   TFMs and sets:
   - `APPDOMAIN_MANAGER_ASM` = assembly name
   - `APPDOMAIN_MANAGER_TYPE` = `WpfHotReload.Runtime.FrameworkStartupHook`
   - `DEVPATH` = helper DLL directory
   - Instead of `DOTNET_STARTUP_HOOKS` for Core projects

3. **Multi-TFM helper builds**: `ensureRuntimeHelperBuilt()` now:
   - Takes the target project as argument to detect its TFM
   - Builds the appropriate TFM-specific helper (net462 or net10.0-windows)
   - Outputs DLL with TFM suffix: `WpfHotReload.Runtime-{tfm}.dll`

### Integration Tests

- **frameworkHotReload.integration.ts**: Full end-to-end test that:
  - Verifies .NET Framework project detection
  - Launches the net462 sample via AppDomainManager injection
  - Connects to the named pipe
  - Pushes XAML updates and verifies changes apply
  - Same test pattern as the .NET Core runtime hot reload test

### Sample Project

- **sample/net462/**: New legacy-style WPF project for .NET Framework 4.6.2
  with linked source files from `../net6.0/`. All compilation via `msbuild`.

using System;
using System.Diagnostics;
using System.Threading;
using XamlLanguageServer.Wpf.Diagnostics;
using XamlLanguageServer.Wpf.Workspace;
using XamlToCSharpGenerator.WPF.Framework;
using XamlToCSharpGenerator.LanguageService;
using XamlToCSharpGenerator.LanguageService.Symbols;
using XamlToCSharpGenerator.LanguageService.Workspace;
using XamlToCSharpGenerator.LanguageServer.Protocol;
using XamlToCSharpGenerator.LanguageServer.Server;

// Redirect trace output that might corrupt the LSP stdio stream.
Console.OutputEncoding = System.Text.Encoding.UTF8;

var workspaceRoot = ParseArg(args, "--workspace");
Console.Error.WriteLine($"[WPF-LS] Starting. workspaceRoot={workspaceRoot ?? "(null)"}");
Console.Error.WriteLine($"[WPF-LS] Args: [{string.Join(", ", args)}]");
var options = new XamlLanguageServiceOptions(workspaceRoot);

// Build the two-tier compilation pipeline:
//
//   Tier 1 (WPF-core, instant)
//     A Roslyn compilation built from the Microsoft.WindowsDesktop.App shared
//     framework assemblies.  Standard WPF element / attribute completions
//     appear immediately — no MSBuild wait.
//
//   Tier 2 (full, background)
//     MSBuildCompilationProvider loads the user's project (NuGet packages,
//     user-defined controls).  DiagnosticCompilationProvider wraps it to emit
//     development-time diagnostics to stderr.  The expensive per-assembly
//     attribute scan runs asynchronously and never blocks a completion request.
//
// TieredCompilationProvider manages the handoff between tiers and owns the
// background prewarm task.
var fastSnapshot = WpfFastCompilationProvider.BuildFastSnapshot();
if (fastSnapshot?.Compilation is { } fastCompilation)
{
    var prewarmStopwatch = Stopwatch.StartNew();
    try
    {
        Console.Error.WriteLine(
            "[WPF-LS] Tier-1 metadata warmup: loading cached WPF control/profile metadata " +
            "(or building it once) so default WPF IntelliSense is available before MSBuild completes.");
        _ = AvaloniaTypeIndex.Create(fastCompilation);
        Console.Error.WriteLine($"[WPF-LS] Tier-1 type index ready in {prewarmStopwatch.ElapsedMilliseconds} ms.");
        Console.Error.WriteLine(WpfFastCompilationProvider.PersistTypeIndexToDisk(fastCompilation));
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[WPF-LS] Tier-1 type index prewarm failed: {ex.Message}");
    }
}
var tieredProvider = new TieredCompilationProvider(
    fullProvider: new DiagnosticCompilationProvider(new MsBuildCompilationProvider()),
    fastSnapshot: fastSnapshot);

using var engine = new XamlLanguageServiceEngine(tieredProvider, WpfFrameworkProfile.Instance);

// Kick off the full MSBuild compilation load immediately so the upgrade from
// Tier 1 → Tier 2 happens as early as possible.
if (workspaceRoot is not null)
{
    var projectFile = TieredCompilationProvider.FindFirstProjectFile(workspaceRoot);
    if (projectFile is not null)
    {
        Console.Error.WriteLine($"[WPF-LS] Starting background prewarm for {projectFile}");
        _ = tieredProvider.PrewarmAsync(projectFile, workspaceRoot);
    }
    else
    {
        Console.Error.WriteLine("[WPF-LS] No .csproj found in workspace — prewarm skipped.");
    }
}

using var server = new AxsgLanguageServer(
    new LspMessageReader(Console.OpenStandardInput()),
    new LspMessageWriter(Console.OpenStandardOutput()),
    engine,
    options);

var exitCode = await server.RunAsync(CancellationToken.None).ConfigureAwait(false);
Environment.ExitCode = exitCode;

static string? ParseArg(string[] args, string name)
{
    for (var i = 0; i < args.Length - 1; i++)
    {
        if (string.Equals(args[i], name, StringComparison.Ordinal))
            return args[i + 1];
    }
    return null;
}

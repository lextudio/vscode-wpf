using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using XamlLanguageServer.Wpf.Workspace;
using XamlToCSharpGenerator.Core.Models;
using XamlToCSharpGenerator.LanguageService.Framework.All;
using XamlToCSharpGenerator.LanguageService.Models;
using XamlToCSharpGenerator.LanguageService.Workspace;
using XamlToCSharpGenerator.LanguageService.Workspace.Tier1;

namespace XamlLanguageServer.Wpf.Tests;

/// <summary>
/// Tier 2 replaces Tier 1 only when it can see at least what Tier 1 could. A project that has not
/// been restored still evaluates to a Compilation, just without its framework's assemblies;
/// upgrading to it made every completion empty the moment prewarm finished (observed on a MAUI
/// page in OpenDevelop: "Label" completed once, then nothing ever again).
/// </summary>
public sealed class TieredUpgradeTests
{
    sealed class FixedProvider(Compilation compilation) : ICompilationProvider
    {
        public Task<CompilationSnapshot> GetCompilationAsync(string filePath, string? workspaceRoot, CancellationToken cancellationToken) =>
            Task.FromResult(new CompilationSnapshot(filePath, null, compilation, ImmutableArray<LanguageServiceDiagnostic>.Empty));

        public void Invalidate(string filePath) { }

        public void Dispose() { }
    }

    static CompilationSnapshot WpfFastSnapshot()
    {
        XamlBuiltInLanguageFrameworkRegistry.Instance.TryGetById(FrameworkProfileIds.Wpf, out var wpf);
        return FastCompilationProvider.BuildFastSnapshot(wpf!, WpfTier1ReferenceSet.Instance)
               ?? throw new InvalidOperationException("The WPF reference pack is required (see WpfFastSnapshotTests).");
    }

    static async Task<Compilation?> CompilationAfterPrewarm(CompilationSnapshot fast, Compilation full)
    {
        using var tiered = new TieredCompilationProvider(new FixedProvider(full), fast);
        await tiered.PrewarmAsync("Project.csproj", null);
        return (await tiered.GetCompilationAsync("Page.xaml", null, CancellationToken.None)).Compilation;
    }

    [Fact]
    public async Task An_Unrestored_Project_Does_Not_Replace_Tier1()
    {
        var fast = WpfFastSnapshot();
        var unrestored = CSharpCompilation.Create("Unrestored");

        Assert.NotEmpty(TieredCompilationProvider.MissingFastSnapshotAssemblies(unrestored, fast.Compilation));
        Assert.Same(fast.Compilation, await CompilationAfterPrewarm(fast, unrestored));
    }

    [Fact]
    public async Task A_Full_Compilation_That_Covers_Tier1_Replaces_It()
    {
        var fast = WpfFastSnapshot();
        // Every Tier-1 reference plus the project's own code: what a restored project looks like.
        var restored = CSharpCompilation.Create("Restored", references: fast.Compilation!.References);

        Assert.Empty(TieredCompilationProvider.MissingFastSnapshotAssemblies(restored, fast.Compilation));
        Assert.Same(restored, await CompilationAfterPrewarm(fast, restored));
    }
}

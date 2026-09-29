using XamlLanguageServer.Wpf.Workspace;
using XamlToCSharpGenerator.LanguageService.Symbols;
using XamlToCSharpGenerator.LanguageService.Workspace.Tier1;

namespace XamlLanguageServer.Wpf.Tests;

public sealed class WpfFastSnapshotTests
{
    private const string PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";

    [Fact]
    public void FastSnapshot_ExposesCoreWpfControls()
    {
        var framework = XamlToCSharpGenerator.LanguageService.Framework.Wpf.WpfLanguageFrameworkProvider.Instance.Framework;
        var snapshot = FastCompilationProvider.BuildFastSnapshot(framework, WpfTier1ReferenceSet.Instance);
        Assert.NotNull(snapshot);
        Assert.NotNull(snapshot!.Compilation);

        var index = AvaloniaTypeIndex.Create(snapshot.Compilation!, framework);
        var types = index.GetTypes(PresentationNs);

        Assert.NotEmpty(types);
        Assert.Contains(types, t => string.Equals(t.XmlTypeName, "Button", StringComparison.Ordinal));
        Assert.Contains(types, t => string.Equals(t.XmlTypeName, "Grid", StringComparison.Ordinal));
    }
}

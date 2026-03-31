using XamlLanguageServer.Wpf.Workspace;
using XamlToCSharpGenerator.LanguageService.Symbols;

namespace XamlLanguageServer.Wpf.Tests;

public sealed class WpfFastSnapshotTests
{
    private const string PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";

    [Fact]
    public void FastSnapshot_ExposesCoreWpfControls()
    {
        var snapshot = WpfFastCompilationProvider.BuildFastSnapshot();
        Assert.NotNull(snapshot);
        Assert.NotNull(snapshot!.Compilation);

        var index = AvaloniaTypeIndex.Create(snapshot.Compilation!);
        var types = index.GetTypes(PresentationNs);

        Assert.NotEmpty(types);
        Assert.Contains(types, t => string.Equals(t.XmlTypeName, "Button", StringComparison.Ordinal));
        Assert.Contains(types, t => string.Equals(t.XmlTypeName, "Grid", StringComparison.Ordinal));
    }
}

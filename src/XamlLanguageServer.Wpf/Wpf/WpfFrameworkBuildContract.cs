using XamlToCSharpGenerator.Framework.Abstractions;

namespace XamlLanguageServer.Wpf.Wpf;

/// <summary>
/// WPF MSBuild item-group conventions.
/// WPF XAML files are declared as &lt;Page /&gt; or &lt;ApplicationDefinition /&gt; items.
/// There are no transform rule files (unlike Avalonia's .axamlx format).
/// </summary>
internal sealed class WpfFrameworkBuildContract : IXamlFrameworkBuildContract
{
    public static WpfFrameworkBuildContract Instance { get; } = new();
    private WpfFrameworkBuildContract() { }

    private const string PageGroup = "Page";
    private const string AppDefGroup = "ApplicationDefinition";

    public string SourceItemGroupMetadataName => "SourceItemGroup";
    public string TargetPathMetadataName => "TargetPath";
    public string XamlSourceItemGroup => PageGroup;

    // WPF has no transform-rule files.
    public string TransformRuleSourceItemGroup => string.Empty;

    public bool IsXamlPath(string path) =>
        path.EndsWith(".xaml", StringComparison.OrdinalIgnoreCase);

    public bool IsXamlSourceItemGroup(string? sourceItemGroup) =>
        string.Equals(sourceItemGroup, PageGroup, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(sourceItemGroup, AppDefGroup, StringComparison.OrdinalIgnoreCase);

    public bool IsTransformRuleSourceItemGroup(string? sourceItemGroup) => false;

    public string NormalizeSourceItemGroup(string? sourceItemGroup) =>
        IsXamlSourceItemGroup(sourceItemGroup) ? PageGroup : string.Empty;
}

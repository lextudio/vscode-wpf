using XamlToCSharpGenerator.LanguageService.Framework;
using XamlToCSharpGenerator.LanguageService.Framework.Wpf;

namespace XamlLanguageServer.Wpf.Tests;

/// <summary>
/// The engine takes a framework registry, not a bare profile — the constructor signatures moved
/// from <c>IXamlFrameworkProfile</c> to <c>XamlLanguageFrameworkRegistry</c> and these tests were
/// left behind by that change. They are WPF-only, so they get a registry holding just WPF rather
/// than the full built-in set, which also keeps them independent of which other dialects a given
/// build happens to ship.
/// </summary>
internal static class WpfOnlyFrameworkRegistry
{
    public static XamlLanguageFrameworkRegistry Instance { get; } =
        new XamlLanguageFrameworkRegistryBuilder()
            .Add(WpfLanguageFrameworkProvider.Instance)
            .Build(WpfLanguageFrameworkProvider.Instance.Framework.Id);
}

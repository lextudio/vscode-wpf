using XamlToCSharpGenerator.Core.Models;
using XamlToCSharpGenerator.LanguageService.Framework;
using XamlToCSharpGenerator.LanguageService.Framework.Wpf;

namespace XamlLanguageServer.Wpf.Tests;

/// <summary>
/// WPF-only framework registry shared by tests that construct
/// <see cref="XamlToCSharpGenerator.LanguageService.XamlLanguageServiceEngine"/> directly.
/// Mirrors the registry built in Program.cs — XamlBuiltInLanguageFrameworkRegistry defaults
/// to Avalonia, which is wrong for WPF-focused tests.
/// </summary>
internal static class WpfTestFrameworkRegistry
{
    public static XamlLanguageFrameworkRegistry Instance { get; } =
        new XamlLanguageFrameworkRegistryBuilder()
            .Add(WpfLanguageFrameworkProvider.Instance)
            .Build(FrameworkProfileIds.Wpf);
}

using XamlToCSharpGenerator.LanguageService.Framework;
using XamlToCSharpGenerator.LanguageService.Framework.All;
using XamlToCSharpGenerator.LanguageService.Framework.Wpf;

namespace XamlLanguageServer.Wpf;

/// <summary>
/// Chooses the XAML framework this server instance serves.
/// <para>
/// The engine can pick a framework itself, by inspecting the project's SDK, the compilation's
/// assemblies, or the document's xmlns. A host that already knows the answer should not pay for
/// that guessing: <c>IXamlLanguageFrameworkProvider</c> documents that a host dedicated to one
/// framework "should not guess at all" and should pass its id through
/// <c>XamlLanguageServiceOptions.FrameworkId</c>, which short-circuits detection. Naming the
/// framework on the command line is how that id arrives, and it is what lets one server binary
/// serve any dialect registered in <see cref="XamlBuiltInLanguageFrameworkRegistry"/>.
/// </para>
/// <para>
/// An unknown id is rejected rather than defaulted. Defaulting would serve one framework's XAML
/// as another's, producing completions and diagnostics that are confidently wrong — worse than
/// refusing to start, because the user has no signal that anything is off.
/// </para>
/// </summary>
internal static class FrameworkSelection
{
    /// <summary>Command-line argument carrying the framework id.</summary>
    public const string ArgumentName = "--framework";

    /// <summary>The framework used when no id is supplied, preserving the historical behaviour of
    /// this server, which was written for WPF only.</summary>
    public static XamlLanguageFrameworkInfo Default =>
        WpfLanguageFrameworkProvider.Instance.Framework;

    public static XamlLanguageFrameworkInfo Resolve(string? requestedFrameworkId)
    {
        if (string.IsNullOrWhiteSpace(requestedFrameworkId))
        {
            return Default;
        }

        if (XamlBuiltInLanguageFrameworkRegistry.Instance.TryGetById(requestedFrameworkId, out var resolved))
        {
            return resolved;
        }

        throw new InvalidOperationException(
            $"Unknown XAML framework '{requestedFrameworkId}'. Available: {AvailableIds}.");
    }

    /// <summary>Comma-separated ids this build can serve, for the error message and for logs.</summary>
    public static string AvailableIds =>
        string.Join(", ", XamlBuiltInLanguageFrameworkRegistry.Instance.Providers.Select(p => p.Framework.Id));
}

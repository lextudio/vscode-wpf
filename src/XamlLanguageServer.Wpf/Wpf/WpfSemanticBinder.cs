using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using XamlToCSharpGenerator.Core.Models;
using XamlToCSharpGenerator.Framework.Abstractions;

namespace XamlLanguageServer.Wpf.Wpf;

/// <summary>
/// Semantic binder for WPF XAML.
///
/// Phase 1: Structural parsing and XML diagnostics are produced by the AXSG core parser
/// before this binder is called.  This binder returns null (no resolved view-model) so
/// that higher-level services degrade gracefully while WPF type resolution is absent.
///
/// Phase 2 (future): Walk <paramref name="document"/> elements, resolve each tag name
/// against types discovered via <c>System.Windows.Markup.XmlnsDefinitionAttribute</c>
/// in the Roslyn <paramref name="compilation"/>, produce a full <see cref="ResolvedViewModel"/>
/// enabling completions, hover, go-to-definition, and semantic diagnostics.
/// </summary>
internal sealed class WpfSemanticBinder : IXamlFrameworkSemanticBinder
{
    public static WpfSemanticBinder Instance { get; } = new();
    private WpfSemanticBinder() { }

    public (ResolvedViewModel? ViewModel, ImmutableArray<DiagnosticInfo> Diagnostics) Bind(
        XamlDocumentModel document,
        Compilation compilation,
        GeneratorOptions options,
        XamlTransformConfiguration transformConfiguration)
    {
        // Phase 1: structural XAML parser diagnostics arrive before this call.
        // Return null ViewModel — the analysis service handles null gracefully,
        // still surfacing XML parse errors and namespace validation.
        return (null, ImmutableArray<DiagnosticInfo>.Empty);
    }
}

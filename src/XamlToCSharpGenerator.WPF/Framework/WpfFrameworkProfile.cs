using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using XamlToCSharpGenerator.Core.Abstractions;
using XamlToCSharpGenerator.Core.Models;
using XamlToCSharpGenerator.Framework.Abstractions;
using XamlToCSharpGenerator.WPF.Binding;
using XamlToCSharpGenerator.WPF.Emission;

namespace XamlToCSharpGenerator.WPF.Framework;

/// <summary>
/// XSG framework profile for WPF.
///
/// Follows the same pattern as <c>AvaloniaFrameworkProfile</c> in the XSG engine —
/// a singleton that wires together the WPF-specific semantic binder, code emitter,
/// build contract, and transform provider.
///
/// WPF namespace conventions:
///   xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"   (default)
///   xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
///   xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
///   xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
///   xmlns:local="clr-namespace:MyApp"
///
/// Unlike Avalonia, WPF does not use global xmlns prefix attributes injected at the
/// assembly level. Type-to-namespace mappings are discovered at bind time via
/// <c>System.Windows.Markup.XmlnsDefinitionAttribute</c>.
/// </summary>
public sealed class WpfFrameworkProfile : IXamlFrameworkProfile
{
    private static readonly IXamlFrameworkBuildContract BuildContractInstance =
        WpfFrameworkBuildContract.Instance;

    private static readonly IXamlFrameworkTransformProvider TransformProviderInstance =
        WpfFrameworkTransformProvider.Instance;

    private static readonly IXamlFrameworkSemanticBinder SemanticBinderInstance =
        new WpfFrameworkSemanticBinder(new WpfSemanticBinder());

    private static readonly IXamlFrameworkEmitter EmitterInstance =
        new WpfFrameworkEmitter(new WpfCodeEmitter());

    public static WpfFrameworkProfile Instance { get; } = new();
    private WpfFrameworkProfile() { }

    public string Id => "WPF";

    public IXamlFrameworkBuildContract BuildContract => BuildContractInstance;

    public IXamlFrameworkTransformProvider TransformProvider => TransformProviderInstance;

    public IXamlFrameworkSemanticBinder CreateSemanticBinder() => SemanticBinderInstance;

    public IXamlFrameworkEmitter CreateEmitter() => EmitterInstance;

    /// <summary>
    /// WPF files carry no document enrichers (Phase 1).
    /// Avalonia uses enrichers to inject x:Name members; WPF relies on the name scope
    /// populated during BAML loading (Phase 1) and will switch to direct object construction
    /// in Phase 3.
    /// </summary>
    public ImmutableArray<IXamlDocumentEnricher> CreateDocumentEnrichers() =>
        ImmutableArray<IXamlDocumentEnricher>.Empty;

    /// <summary>
    /// WPF does not use assembly-level global xmlns prefixes, so the prefix map is empty.
    /// The implicit default xmlns points to the WPF presentation namespace so that the
    /// parser tolerates files that omit the explicit default xmlns declaration.
    /// </summary>
    public XamlFrameworkParserSettings BuildParserSettings(Compilation compilation, GeneratorOptions options) =>
        new(
            globalXmlnsPrefixes: ImmutableDictionary<string, string>.Empty,
            allowImplicitDefaultXmlns: false,
            implicitDefaultXmlns: WpfXmlNamespaces.Presentation);

    // -------------------------------------------------------------------------
    // Private adapter classes — mirrors AvaloniaFrameworkProfile's nested classes
    // -------------------------------------------------------------------------

    private sealed class WpfFrameworkSemanticBinder : IXamlFrameworkSemanticBinder
    {
        private readonly IXamlSemanticBinder _inner;
        public WpfFrameworkSemanticBinder(IXamlSemanticBinder inner) => _inner = inner;

        public (ResolvedViewModel? ViewModel, ImmutableArray<DiagnosticInfo> Diagnostics) Bind(
            XamlDocumentModel document,
            Compilation compilation,
            GeneratorOptions options,
            XamlTransformConfiguration transformConfiguration)
            => _inner.Bind(document, compilation, options, transformConfiguration);
    }

    private sealed class WpfFrameworkEmitter : IXamlFrameworkEmitter
    {
        private readonly IXamlCodeEmitter _inner;
        public WpfFrameworkEmitter(IXamlCodeEmitter inner) => _inner = inner;

        public (string HintName, string Source) Emit(ResolvedViewModel viewModel)
            => _inner.Emit(viewModel);
    }
}

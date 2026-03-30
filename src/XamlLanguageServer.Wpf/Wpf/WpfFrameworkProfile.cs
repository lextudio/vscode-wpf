using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using XamlToCSharpGenerator.Core.Models;
using XamlToCSharpGenerator.Framework.Abstractions;

namespace XamlLanguageServer.Wpf.Wpf;

/// <summary>
/// XSG framework profile for WPF.
///
/// WPF namespace conventions:
///   xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"   (default)
///   xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
///   xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
///   xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
///   xmlns:local="clr-namespace:MyApp"
///
/// Unlike Avalonia, WPF does not use global xmlns prefix attributes injected at the
/// assembly level — every file declares its own prefixes.  Type-to-namespace mappings
/// are discovered at bind time via <c>System.Windows.Markup.XmlnsDefinitionAttribute</c>
/// present in PresentationFramework, PresentationCore, and WindowsBase.
/// </summary>
public sealed class WpfFrameworkProfile : IXamlFrameworkProfile
{
    public static WpfFrameworkProfile Instance { get; } = new();
    private WpfFrameworkProfile() { }

    public string Id => "WPF";

    public IXamlFrameworkBuildContract BuildContract =>
        WpfFrameworkBuildContract.Instance;

    public IXamlFrameworkTransformProvider TransformProvider =>
        WpfFrameworkTransformProvider.Instance;

    public IXamlFrameworkSemanticBinder CreateSemanticBinder() =>
        WpfSemanticBinder.Instance;

    public IXamlFrameworkEmitter CreateEmitter() =>
        WpfCodeEmitter.Instance;

    /// <summary>
    /// WPF files carry no generated document enrichers.
    /// (Avalonia uses enrichers to inject x:Name members; WPF relies on the
    /// standard BAML codegen pipeline for that.)
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
}

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using XamlToCSharpGenerator.Core.Models;
using XamlToCSharpGenerator.WPF.Framework;

namespace XamlLanguageServer.Wpf.Tests;

public sealed class WpfFrameworkProfileSimplerXamlTests
{
    private const string AvaloniaDefaultImplicitXmlns = "https://github.com/avaloniaui";

    [Fact]
    public void BuildParserSettings_Provides_SimplerXaml_Implicit_Namespaces_And_Global_Prefixes()
    {
        var compilation = CreateCompilation();
        var options = CreateOptions(compilation.AssemblyName);

        var settings = WpfFrameworkProfile.Instance.BuildParserSettings(compilation, options);

        Assert.True(settings.AllowImplicitDefaultXmlns);
        Assert.Equal(WpfXmlNamespaces.Presentation, settings.ImplicitDefaultXmlns);

        Assert.True(settings.GlobalXmlnsPrefixes.TryGetValue(string.Empty, out var defaultNs));
        Assert.Equal(WpfXmlNamespaces.Presentation, defaultNs);
        Assert.True(settings.GlobalXmlnsPrefixes.TryGetValue("x", out var xamlNs));
        Assert.Equal(WpfXmlNamespaces.Xaml, xamlNs);
        Assert.True(settings.GlobalXmlnsPrefixes.TryGetValue("d", out var blendNs));
        Assert.Equal(WpfXmlNamespaces.BlendDesign, blendNs);
        Assert.True(settings.GlobalXmlnsPrefixes.TryGetValue("mc", out var markupCompatibilityNs));
        Assert.Equal(WpfXmlNamespaces.MarkupCompatibility, markupCompatibilityNs);
        Assert.True(settings.GlobalXmlnsPrefixes.TryGetValue("views", out var viewsNs));
        Assert.Equal("clr-namespace:TestWpf.Views", viewsNs);
        Assert.True(settings.GlobalXmlnsPrefixes.TryGetValue("controls", out var controlsNs));
        Assert.Equal("clr-namespace:TestWpf.Controls", controlsNs);
    }

    [Fact]
    public void BuildParserSettings_Uses_Wpf_Default_Xmlns_When_Implicit_Default_Comes_From_Shared_Avalonia_Default()
    {
        var compilation = CreateCompilation();
        var options = CreateOptions(compilation.AssemblyName) with
        {
            ImplicitDefaultXmlns = AvaloniaDefaultImplicitXmlns
        };

        var settings = WpfFrameworkProfile.Instance.BuildParserSettings(compilation, options);

        Assert.Equal(WpfXmlNamespaces.Presentation, settings.ImplicitDefaultXmlns);
        Assert.True(settings.GlobalXmlnsPrefixes.TryGetValue(string.Empty, out var defaultNs));
        Assert.Equal(WpfXmlNamespaces.Presentation, defaultNs);
    }

    private static GeneratorOptions CreateOptions(string? assemblyName)
    {
        return new GeneratorOptions(
            IsEnabled: true,
            UseCompiledBindingsByDefault: false,
            CSharpExpressionsEnabled: false,
            ImplicitCSharpExpressionsEnabled: false,
            CreateSourceInfo: false,
            StrictMode: false,
            HotReloadEnabled: false,
            HotReloadErrorResilienceEnabled: false,
            IdeHotReloadEnabled: false,
            HotDesignEnabled: false,
            IosHotReloadEnabled: false,
            IosHotReloadUseInterpreter: false,
            DotNetWatchBuild: false,
            BuildingInsideVisualStudio: false,
            BuildingByReSharper: false,
            TracePasses: false,
            MetricsEnabled: false,
            MetricsDetailed: false,
            MarkupParserLegacyInvalidNamedArgumentFallbackEnabled: false,
            TypeResolutionCompatibilityFallbackEnabled: false,
            AllowImplicitXmlnsDeclaration: false,
            ImplicitStandardXmlnsPrefixesEnabled: true,
            ImplicitDefaultXmlns: string.Empty,
            InferClassFromPath: false,
            ImplicitProjectNamespacesEnabled: false,
            GlobalXmlnsPrefixes: "controls=clr-namespace:TestWpf.Controls",
            RootNamespace: null,
            IntermediateOutputPath: null,
            BaseIntermediateOutputPath: null,
            ProjectDirectory: null,
            Backend: "SourceGen",
            AssemblyName: assemblyName);
    }

    private static Compilation CreateCompilation()
    {
        const string source = """
            using System;

            [assembly: System.Windows.Markup.XmlnsPrefix("clr-namespace:TestWpf.Views", "views")]

            namespace System.Windows.Markup
            {
                [AttributeUsage(AttributeTargets.Assembly, AllowMultiple = true)]
                public sealed class XmlnsPrefixAttribute : Attribute
                {
                    public XmlnsPrefixAttribute(string xmlNamespace, string prefix) { }
                }
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(source, path: "/tmp/WpfXmlnsPrefixTypes.cs");
        var references = new[]
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Attribute).Assembly.Location),
        };

        return CSharpCompilation.Create(
            "WpfFrameworkProfileTests",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
    }
}

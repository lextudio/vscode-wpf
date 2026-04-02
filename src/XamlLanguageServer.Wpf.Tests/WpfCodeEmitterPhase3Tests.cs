using System;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using XamlToCSharpGenerator.Core.Models;
using XamlToCSharpGenerator.Core.Parsing;
using XamlToCSharpGenerator.WPF.Binding;
using XamlToCSharpGenerator.WPF.Emission;

namespace XamlLanguageServer.Wpf.Tests;

public sealed class WpfCodeEmitterPhase3Tests
{
    private const string PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private const string XamlNs = "http://schemas.microsoft.com/winfx/2006/xaml";

    [Fact]
    public void Emit_Uses_Pure_CSharp_ObjectGraph_And_No_LoadComponent()
    {
        var compilation = CreateWpfCompilation();
        var parser = new SimpleXamlDocumentParser();
        var binder = new WpfSemanticBinder();
        var emitter = new WpfCodeEmitter();

        var xaml =
            $"<Window xmlns=\"{PresentationNs}\" xmlns:x=\"{XamlNs}\" x:Class=\"TestWpf.Controls.MainWindow\" Title=\"Hello\">\n" +
            "  <Grid Grid.Row=\"1\">\n" +
            "    <Button x:Name=\"MyButton\" Click=\"OnClick\" />\n" +
            "  </Grid>\n" +
            "</Window>";

        var (document, parseDiagnostics) = parser.Parse(new XamlFileInput(
            FilePath: "/tmp/MainWindow.xaml",
            TargetPath: "MainWindow.xaml",
            SourceItemGroup: "Page",
            Text: xaml));

        Assert.NotNull(document);
        Assert.Empty(parseDiagnostics.Where(static d => d.IsError));

        var (viewModel, diagnostics) = binder.Bind(
            document!,
            compilation,
            CreateOptions(compilation.AssemblyName),
            XamlTransformConfiguration.Empty);

        Assert.NotNull(viewModel);
        Assert.Empty(diagnostics.Where(static d => d.IsError));

        var (_, source) = emitter.Emit(viewModel!);

        Assert.DoesNotContain("Application.LoadComponent", source, StringComparison.Ordinal);
        Assert.DoesNotContain("IComponentConnector", source, StringComparison.Ordinal);
        Assert.Contains("__WXSG_BuildObjectGraph", source, StringComparison.Ordinal);
        Assert.Contains("__WXSG_HOT_RELOAD__", source, StringComparison.Ordinal);
        Assert.Contains("__WXSG_ApplyHotReload", source, StringComparison.Ordinal);
        Assert.Contains("__WXSG_ResetForHotReload", source, StringComparison.Ordinal);
        Assert.Contains("new global::TestWpf.Controls.Grid()", source, StringComparison.Ordinal);
        Assert.Contains("new global::TestWpf.Controls.Button()", source, StringComparison.Ordinal);
        Assert.Contains("global::TestWpf.Controls.Grid.SetRow", source, StringComparison.Ordinal);
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
            ImplicitStandardXmlnsPrefixesEnabled: false,
            ImplicitDefaultXmlns: string.Empty,
            InferClassFromPath: false,
            ImplicitProjectNamespacesEnabled: false,
            GlobalXmlnsPrefixes: null,
            RootNamespace: null,
            IntermediateOutputPath: null,
            BaseIntermediateOutputPath: null,
            ProjectDirectory: null,
            Backend: "SourceGen",
            AssemblyName: assemblyName);
    }

    private static Compilation CreateWpfCompilation()
    {
        const string source = """
            using System;
            using System.Collections.Generic;

            [assembly: System.Windows.Markup.XmlnsDefinition(
                "http://schemas.microsoft.com/winfx/2006/xaml/presentation",
                "TestWpf.Controls")]

            namespace System.Windows.Markup
            {
                [AttributeUsage(AttributeTargets.Assembly, AllowMultiple = true)]
                public sealed class XmlnsDefinitionAttribute : Attribute
                {
                    public XmlnsDefinitionAttribute(string xmlNamespace, string clrNamespace) { }
                    public string? AssemblyName { get; set; }
                }

                [AttributeUsage(AttributeTargets.Class, AllowMultiple = false)]
                public sealed class ContentPropertyAttribute : Attribute
                {
                    public ContentPropertyAttribute(string name) { }
                }
            }

            namespace TestWpf.Controls
            {
                public class DependencyProperty { }
                public class RoutedEvent { }

                [System.Windows.Markup.ContentProperty("Content")]
                public class Window
                {
                    public object Content { get; set; } = new object();
                    public string Title { get; set; } = string.Empty;
                }

                [System.Windows.Markup.ContentProperty("Children")]
                public class Grid
                {
                    public List<object> Children { get; } = new List<object>();
                    public static readonly DependencyProperty RowProperty = new DependencyProperty();
                    public static void SetRow(object target, int value) { }
                    public static int GetRow(object target) => 0;
                }

                public class Button
                {
                    public event EventHandler? Click;
                }

                public partial class MainWindow : Window
                {
                }
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(source, path: "/tmp/WpfEmitterTypes.cs");
        var references = new[]
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Attribute).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Enumerable).Assembly.Location),
        };

        return CSharpCompilation.Create(
            "WpfCodeEmitterTests",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
    }
}

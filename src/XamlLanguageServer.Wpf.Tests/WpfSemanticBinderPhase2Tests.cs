using System;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using XamlToCSharpGenerator.Core.Models;
using XamlToCSharpGenerator.Core.Parsing;
using XamlToCSharpGenerator.WPF.Binding;
using XamlToCSharpGenerator.WPF.Framework;

namespace XamlLanguageServer.Wpf.Tests;

public sealed class WpfSemanticBinderPhase2Tests
{
    private const string PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private const string XamlNs = "http://schemas.microsoft.com/winfx/2006/xaml";

    [Fact]
    public void Bind_Resolves_Properties_Attached_Properties_And_Events()
    {
        var compilation = CreateWpfCompilation();
        var parser = new SimpleXamlDocumentParser();

        var xaml =
            $"<Window xmlns=\"{PresentationNs}\" xmlns:x=\"{XamlNs}\" x:Class=\"TestWpf.Controls.MainWindow\" Title=\"Hello\">\n" +
            "  <Grid Grid.Row=\"1\">\n" +
            "    <Button Click=\"OnClick\" Grid.Column=\"2\" />\n" +
            "  </Grid>\n" +
            "</Window>";

        var (document, parseDiagnostics) = parser.Parse(new XamlFileInput(
            FilePath: "/tmp/MainWindow.xaml",
            TargetPath: "MainWindow.xaml",
            SourceItemGroup: "Page",
            Text: xaml));

        Assert.NotNull(document);
        Assert.Empty(parseDiagnostics.Where(static d => d.IsError));

        var binder = new WpfSemanticBinder();
        var (viewModel, diagnostics) = binder.Bind(
            document!,
            compilation,
            CreateOptions(compilation.AssemblyName),
            XamlTransformConfiguration.Empty);

        Assert.NotNull(viewModel);
        Assert.Empty(diagnostics.Where(static d => d.IsError));

        var root = viewModel!.RootObject;
        Assert.Equal("TestWpf.Controls.Window", root.TypeName);
        Assert.Contains(root.PropertyAssignments, a =>
            a.PropertyName == "Title" &&
            a.ClrPropertyOwnerTypeName == "global::TestWpf.Controls.Window");

        var grid = Assert.Single(root.Children);
        Assert.Contains(grid.PropertyAssignments, a =>
            a.PropertyName == "Row" &&
            a.ClrPropertyOwnerTypeName == "TestWpf.Controls.Grid");

        var button = Assert.Single(grid.Children);
        Assert.Contains(button.PropertyAssignments, a =>
            a.PropertyName == "Column" &&
            a.ClrPropertyOwnerTypeName == "TestWpf.Controls.Grid");
        Assert.Contains(button.EventSubscriptions, e =>
            e.EventName == "Click" && e.HandlerMethodName == "OnClick");
    }

    [Fact]
    public void Bind_Resolves_Property_Elements()
    {
        var compilation = CreateWpfCompilation();
        var parser = new SimpleXamlDocumentParser();

        var xaml =
            $"<Window xmlns=\"{PresentationNs}\" xmlns:x=\"{XamlNs}\" x:Class=\"TestWpf.Controls.MainWindow\">\n" +
            "  <Window.Content>\n" +
            "    <Button />\n" +
            "  </Window.Content>\n" +
            "</Window>";

        var (document, parseDiagnostics) = parser.Parse(new XamlFileInput(
            FilePath: "/tmp/MainWindow.xaml",
            TargetPath: "MainWindow.xaml",
            SourceItemGroup: "Page",
            Text: xaml));

        Assert.NotNull(document);
        Assert.Empty(parseDiagnostics.Where(static d => d.IsError));

        var binder = new WpfSemanticBinder();
        var (viewModel, diagnostics) = binder.Bind(
            document!,
            compilation,
            CreateOptions(compilation.AssemblyName),
            XamlTransformConfiguration.Empty);

        Assert.NotNull(viewModel);
        Assert.Empty(diagnostics.Where(static d => d.IsError));

        var contentAssignment = Assert.Single(viewModel!.RootObject.PropertyElementAssignments);
        Assert.Equal("Content", contentAssignment.PropertyName);
        Assert.Equal("global::TestWpf.Controls.Window", contentAssignment.ClrPropertyOwnerTypeName);
        Assert.True(
            contentAssignment.ClrPropertyTypeName == "global::System.Object" ||
            contentAssignment.ClrPropertyTypeName == "object");

        var contentObject = Assert.Single(contentAssignment.ObjectValues);
        Assert.Equal("TestWpf.Controls.Button", contentObject.TypeName);
    }

    [Fact]
    public void Bind_Reports_Unknown_Type_And_Property_Diagnostics()
    {
        var compilation = CreateWpfCompilation();
        var parser = new SimpleXamlDocumentParser();

        var xaml =
            $"<Window xmlns=\"{PresentationNs}\" xmlns:x=\"{XamlNs}\" x:Class=\"TestWpf.Controls.MainWindow\">\n" +
            "  <UnknownControl />\n" +
            "  <Button UnknownProp=\"x\" />\n" +
            "</Window>";

        var (document, parseDiagnostics) = parser.Parse(new XamlFileInput(
            FilePath: "/tmp/MainWindow.xaml",
            TargetPath: "MainWindow.xaml",
            SourceItemGroup: "Page",
            Text: xaml));

        Assert.NotNull(document);
        Assert.Empty(parseDiagnostics.Where(static d => d.IsError));

        var binder = new WpfSemanticBinder();
        var (_, diagnostics) = binder.Bind(
            document!,
            compilation,
            CreateOptions(compilation.AssemblyName),
            XamlTransformConfiguration.Empty);

        Assert.Contains(diagnostics, d => d.Id == "WXSG0101");
        Assert.Contains(diagnostics, d => d.Id == "WXSG0102");
    }

    [Fact]
    public void Bind_Parses_Inline_CSharp_Expression_Markup()
    {
        var compilation = CreateWpfCompilation();
        var parser = new SimpleXamlDocumentParser();

        var xaml =
            $"<Window xmlns=\"{PresentationNs}\" xmlns:x=\"{XamlNs}\" x:Class=\"TestWpf.Controls.MainWindow\" " +
            "Title=\"{cs: string.Concat(&quot;Hello&quot;, &quot; WXSG&quot;)}\" />";

        var (document, parseDiagnostics) = parser.Parse(new XamlFileInput(
            FilePath: "/tmp/MainWindow.xaml",
            TargetPath: "MainWindow.xaml",
            SourceItemGroup: "Page",
            Text: xaml));

        Assert.NotNull(document);
        Assert.Empty(parseDiagnostics.Where(static d => d.IsError));

        var binder = new WpfSemanticBinder();
        var (viewModel, diagnostics) = binder.Bind(
            document!,
            compilation,
            CreateOptions(compilation.AssemblyName, csharpExpressionsEnabled: true),
            XamlTransformConfiguration.Empty);

        Assert.NotNull(viewModel);
        Assert.Empty(diagnostics.Where(static d => d.IsError));

        var titleAssignment = Assert.Single(viewModel!.RootObject.PropertyAssignments.Where(a => a.PropertyName == "Title"));
        Assert.Equal(ResolvedValueKind.MarkupExtension, titleAssignment.ValueKind);
        Assert.Equal("string.Concat(\"Hello\", \" WXSG\")", titleAssignment.ValueExpression);
    }

    [Fact]
    public void Bind_Resolves_SimplerXaml_Without_Explicit_Xmlns_Declarations()
    {
        var compilation = CreateWpfCompilation();
        var options = CreateOptions(
            compilation.AssemblyName,
            implicitStandardXmlnsPrefixesEnabled: true);
        var parserSettings = WpfFrameworkProfile.Instance.BuildParserSettings(compilation, options);
        var parser = new SimpleXamlDocumentParser(
            parserSettings.GlobalXmlnsPrefixes,
            parserSettings.AllowImplicitDefaultXmlns,
            parserSettings.ImplicitDefaultXmlns);

        var xaml =
            "<Window x:Class=\"TestWpf.Controls.MainWindow\" Title=\"Hello\">\n" +
            "  <Grid>\n" +
            "    <Button />\n" +
            "  </Grid>\n" +
            "</Window>";

        var (document, parseDiagnostics) = parser.Parse(new XamlFileInput(
            FilePath: "/tmp/MainWindow.xaml",
            TargetPath: "MainWindow.xaml",
            SourceItemGroup: "Page",
            Text: xaml));

        Assert.NotNull(document);
        Assert.Empty(parseDiagnostics.Where(static d => d.IsError));

        var binder = new WpfSemanticBinder();
        var (viewModel, diagnostics) = binder.Bind(
            document!,
            compilation,
            options,
            XamlTransformConfiguration.Empty);

        Assert.NotNull(viewModel);
        Assert.Empty(diagnostics.Where(static d => d.IsError));

        Assert.Equal("TestWpf.Controls.Window", viewModel!.RootObject.TypeName);
        var grid = Assert.Single(viewModel.RootObject.Children);
        Assert.Equal("TestWpf.Controls.Grid", grid.TypeName);
        var button = Assert.Single(grid.Children);
        Assert.Equal("TestWpf.Controls.Button", button.TypeName);
    }

    private static GeneratorOptions CreateOptions(
        string? assemblyName,
        bool csharpExpressionsEnabled = false,
        bool implicitCSharpExpressionsEnabled = false,
        bool implicitStandardXmlnsPrefixesEnabled = false)
    {
        return new GeneratorOptions(
            IsEnabled: true,
            UseCompiledBindingsByDefault: false,
            CSharpExpressionsEnabled: csharpExpressionsEnabled,
            ImplicitCSharpExpressionsEnabled: implicitCSharpExpressionsEnabled,
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
            ImplicitStandardXmlnsPrefixesEnabled: implicitStandardXmlnsPrefixesEnabled,
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
                    public static readonly DependencyProperty ColumnProperty = new DependencyProperty();
                    public static readonly RoutedEvent TapEvent = new RoutedEvent();

                    public static void SetRow(object target, int value) { }
                    public static int GetRow(object target) => 0;
                    public static void SetColumn(object target, int value) { }
                    public static int GetColumn(object target) => 0;
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

        var syntaxTree = CSharpSyntaxTree.ParseText(source, path: "/tmp/WpfBinderTypes.cs");
        var references = new[]
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Attribute).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Enumerable).Assembly.Location),
        };

        return CSharpCompilation.Create(
            "WpfSemanticBinderTests",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
    }
}

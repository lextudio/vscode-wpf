using System;
using System.Collections.Immutable;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using XamlToCSharpGenerator.WPF.Framework;
using XamlToCSharpGenerator.LanguageService;
using XamlToCSharpGenerator.LanguageService.Models;
using XamlToCSharpGenerator.LanguageService.Workspace;
using static XamlToCSharpGenerator.LanguageService.Models.LanguageServiceDiagnosticSeverity;

namespace XamlLanguageServer.Wpf.Tests;

/// <summary>
/// Integration tests that verify WPF XAML completions and diagnostics by running the
/// language service engine with an in-memory compilation that simulates WPF's
/// System.Windows.Markup.XmlnsDefinitionAttribute mappings.
/// </summary>
public sealed class WpfCompletionIntegrationTests
{
    // WPF namespace URIs used in test XAML documents
    private const string PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private const string XamlNs = "http://schemas.microsoft.com/winfx/2006/xaml";

    // Fake filesystem path for test documents — must end in .xaml
    private const string TestFilePath = "/tmp/TestMainWindow.xaml";
    private const string TestFileUri = "file:///tmp/TestMainWindow.xaml";
    private const string WorkspaceRoot = "/tmp";

    private static readonly Lazy<Compilation> _sharedCompilation =
        new(CreateWpfCompilation, LazyThreadSafetyMode.ExecutionAndPublication);

    private static XamlLanguageServiceEngine CreateEngine() =>
        new(new InMemoryCompilationProvider(_sharedCompilation.Value), WpfFrameworkProfile.Instance);

    private static XamlLanguageServiceOptions Options(bool semanticDiagnostics = false) =>
        new(WorkspaceRoot, IncludeSemanticDiagnostics: semanticDiagnostics);

    // -----------------------------------------------------------------------
    // Completion tests
    // -----------------------------------------------------------------------

    [Fact]
    public async Task Completion_BareFragment_ReturnsWpfControlTypes()
    {
        using var engine = CreateEngine();
        const string xaml = "<Bu";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);
        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(0, 3),
            Options(),
            CancellationToken.None);

        Assert.Contains(completions, c => c.Label.EndsWith("Button", StringComparison.Ordinal));
    }

    /// <summary>
    /// Real-world scenario: full WPF XAML with explicit xmlns, user types "&lt;Bu"
    /// inside Grid. Verifies Button is found via the WPF presentation namespace.
    /// </summary>
    [Fact]
    public async Task Completion_InsideGridInFullDocument_ReturnsButton()
    {
        using var engine = CreateEngine();
        const string xaml =
            $"<Window xmlns=\"{PresentationNs}\"\n" +
            $"        xmlns:x=\"{XamlNs}\"\n" +
            "        Title=\"Test\" Width=\"800\" Height=\"450\">\n" +
            "  <Grid>\n" +
            "    <Bu\n" +
            "  </Grid>\n" +
            "</Window>";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);

        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(4, 6),
            Options(),
            CancellationToken.None);

        Assert.NotEmpty(completions);
        Assert.Contains(completions, c => c.Label.EndsWith("Button", StringComparison.Ordinal));
    }

    /// <summary>
    /// Key test: user types just "&lt;" with no further letters inside Grid of a full WPF document.
    /// Must return ALL WPF types (Button, TextBlock, Grid, etc.), not just App/MainWindow.
    /// </summary>
    [Fact]
    public async Task Completion_InsideGridInFullDocument_EmptyPrefix_ReturnsAllWpfTypes()
    {
        using var engine = CreateEngine();
        const string xaml =
            $"<Window xmlns=\"{PresentationNs}\"\n" +
            $"        xmlns:x=\"{XamlNs}\"\n" +
            "        Title=\"Test\" Width=\"800\" Height=\"450\">\n" +
            "  <Grid>\n" +
            "    <\n" +
            "  </Grid>\n" +
            "</Window>";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);

        // cursor right after "<" on line 4, col 5
        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(4, 5),
            Options(),
            CancellationToken.None);

        Assert.NotEmpty(completions);
        // Must include standard WPF types, not just the project's own App/MainWindow
        Assert.Contains(completions, c => c.Label == "Button");
        Assert.Contains(completions, c => c.Label == "TextBlock");
        Assert.Contains(completions, c => c.Label == "Grid");
        Assert.Contains(completions, c => c.Label == "StackPanel");
        Assert.Contains(completions, c => c.Label == "TextBox");
    }

    [Fact]
    public async Task Completion_InsideGridInFullDocument_ReturnsGrid()
    {
        using var engine = CreateEngine();
        const string xaml =
            $"<Window xmlns=\"{PresentationNs}\"\n" +
            $"        xmlns:x=\"{XamlNs}\"\n" +
            "        Title=\"Test\" Width=\"800\" Height=\"450\">\n" +
            "  <Grid>\n" +
            "    <Gr\n" +
            "  </Grid>\n" +
            "</Window>";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);

        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(4, 6),
            Options(),
            CancellationToken.None);

        Assert.Contains(completions, c => c.Label.EndsWith("Grid", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Completion_ButtonAttributes_ReturnsContentAndBackground()
    {
        using var engine = CreateEngine();
        const string xaml =
            $"<Window xmlns=\"{PresentationNs}\" xmlns:x=\"{XamlNs}\">\n" +
            "  <Grid>\n" +
            "    <Button \n" +
            "  </Grid>\n" +
            "</Window>";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);

        // Position cursor inside the <Button  > tag (after "Button ")
        int tagStart = xaml.IndexOf("<Button ", StringComparison.Ordinal);
        var cursorOffset = tagStart + "<Button ".Length;
        var (line, col) = OffsetToPosition(xaml, cursorOffset);

        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(line, col),
            Options(),
            CancellationToken.None);

        Assert.Contains(completions, c => string.Equals(c.Label, "Content", StringComparison.Ordinal));
        Assert.Contains(completions, c => string.Equals(c.Label, "Background", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Completion_TextBlockAttributes_ReturnsTextProperty()
    {
        using var engine = CreateEngine();
        const string xaml =
            $"<Window xmlns=\"{PresentationNs}\" xmlns:x=\"{XamlNs}\">\n" +
            "  <TextBlock \n" +
            "</Window>";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);

        int tagStart = xaml.IndexOf("<TextBlock ", StringComparison.Ordinal);
        var cursorOffset = tagStart + "<TextBlock ".Length;
        var (line, col) = OffsetToPosition(xaml, cursorOffset);

        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(line, col),
            Options(),
            CancellationToken.None);

        Assert.Contains(completions, c => string.Equals(c.Label, "Text", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Completion_InRootWindow_DoesNotReturnAvaloniaNamespaceTypes()
    {
        using var engine = CreateEngine();
        const string xaml = "<Us";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);
        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(0, 3),
            Options(),
            CancellationToken.None);

        // Should not suggest Avalonia-only types that aren't in the WPF compilation
        Assert.DoesNotContain(completions, c =>
            c.Label.EndsWith("AvaloniaObject", StringComparison.Ordinal) ||
            c.Label.EndsWith("AvaloniaProperty", StringComparison.Ordinal));
    }

    // -----------------------------------------------------------------------
    // Diagnostics tests
    // -----------------------------------------------------------------------

    [Fact]
    public async Task Diagnostics_WellFormedWpfXaml_ReturnsNoDiagnostics()
    {
        using var engine = CreateEngine();
        const string xaml =
            $"<Window xmlns=\"{PresentationNs}\"\n" +
            $"        xmlns:x=\"{XamlNs}\"\n" +
            "        x:Class=\"TestApp.MainWindow\"\n" +
            "        Title=\"Test\" Width=\"800\" Height=\"450\">\n" +
            "  <Grid>\n" +
            "    <Button Content=\"Click me\" />\n" +
            "  </Grid>\n" +
            "</Window>";

        var diagnostics = await engine.OpenDocumentAsync(
            TestFileUri, xaml, 1,
            new XamlLanguageServiceOptions(WorkspaceRoot, IncludeSemanticDiagnostics: true),
            CancellationToken.None);

        // No parse-level errors expected for valid XAML
        Assert.DoesNotContain(diagnostics, d => d.Severity == Error);
    }

    [Fact]
    public async Task Diagnostics_MalformedXaml_ReturnsParseError()
    {
        using var engine = CreateEngine();
        const string xaml = "<Window><Grid></Window>";  // mismatched tags

        var diagnostics = await engine.OpenDocumentAsync(
            TestFileUri, xaml, 1, Options(semanticDiagnostics: false), CancellationToken.None);

        // Expect at least one diagnostic due to XML parse failure or mismatch
        Assert.NotEmpty(diagnostics);
    }

    // -----------------------------------------------------------------------
    // Helper utilities
    // -----------------------------------------------------------------------

    private static (int line, int col) OffsetToPosition(string text, int offset)
    {
        int line = 0, col = 0;
        for (int i = 0; i < offset && i < text.Length; i++)
        {
            if (text[i] == '\n') { line++; col = 0; }
            else { col++; }
        }
        return (line, col);
    }

    // -----------------------------------------------------------------------
    // In-memory WPF compilation factory
    // -----------------------------------------------------------------------

    /// <summary>
    /// Creates a Roslyn compilation that mimics a minimal WPF project assembly.
    /// It declares <c>System.Windows.Markup.XmlnsDefinitionAttribute</c> and uses it
    /// to map the WPF presentation namespace to test control types (Button, Grid, etc.),
    /// allowing AvaloniaTypeIndex (and our WPF extension of it) to discover WPF types.
    /// </summary>
    private static Compilation CreateWpfCompilation()
    {
        const string source = """
            using System;

            // Map the WPF presentation namespace to the test controls namespace.
            // This simulates PresentationFramework.dll's XmlnsDefinitionAttributes.
            [assembly: System.Windows.Markup.XmlnsDefinition(
                "http://schemas.microsoft.com/winfx/2006/xaml/presentation",
                "TestWpf.Controls")]

            namespace System.Windows.Markup
            {
                /// <summary>
                /// Simulates the real WPF XmlnsDefinitionAttribute.
                /// Constructor signature must match: (string xmlNamespace, string clrNamespace).
                /// </summary>
                [AttributeUsage(AttributeTargets.Assembly, AllowMultiple = true)]
                public sealed class XmlnsDefinitionAttribute : Attribute
                {
                    public XmlnsDefinitionAttribute(string xmlNamespace, string clrNamespace) { }
                }
            }

            namespace System.Windows
            {
                public class DependencyObject { }

                public class UIElement : DependencyObject { }

                public class FrameworkElement : UIElement
                {
                    public double Width { get; set; }
                    public double Height { get; set; }
                    public string? Name { get; set; }
                    public Thickness Margin { get; set; }
                    public HorizontalAlignment HorizontalAlignment { get; set; }
                    public VerticalAlignment VerticalAlignment { get; set; }
                }

                public struct Thickness { }

                public enum HorizontalAlignment { Left, Center, Right, Stretch }
                public enum VerticalAlignment { Top, Center, Bottom, Stretch }
            }

            namespace System.Windows.Media
            {
                public class Brush { }
                public class SolidColorBrush : Brush { }
            }

            namespace TestWpf.Controls
            {
                using System.Windows;
                using System.Windows.Media;

                public class Control : FrameworkElement
                {
                    public Brush? Background { get; set; }
                    public Brush? Foreground { get; set; }
                }

                public class ContentControl : Control
                {
                    public object? Content { get; set; }
                }

                public class Window : ContentControl
                {
                    public string Title { get; set; } = string.Empty;
                    public WindowStartupLocation WindowStartupLocation { get; set; }
                }

                public enum WindowStartupLocation { Manual, CenterScreen, CenterOwner }

                public class Panel : FrameworkElement { }

                public class Grid : Panel
                {
                    public int Row { get; set; }
                    public int Column { get; set; }
                }

                public class StackPanel : Panel
                {
                    public Orientation Orientation { get; set; }
                }

                public enum Orientation { Horizontal, Vertical }

                public class Button : ContentControl
                {
                    public event EventHandler? Click;
                    public string? Command { get; set; }
                }

                public class TextBlock : FrameworkElement
                {
                    public string Text { get; set; } = string.Empty;
                    public double FontSize { get; set; }
                    public Brush? Foreground { get; set; }
                }

                public class TextBox : Control
                {
                    public string Text { get; set; } = string.Empty;
                    public bool IsReadOnly { get; set; }
                }

                public class Label : ContentControl { }

                public class Image : FrameworkElement
                {
                    public object? Source { get; set; }
                }

                public class Border : Decorator
                {
                    public Brush? BorderBrush { get; set; }
                    public Thickness BorderThickness { get; set; }
                    public Thickness Padding { get; set; }
                    public double CornerRadius { get; set; }
                }

                public class Decorator : FrameworkElement
                {
                    public UIElement? Child { get; set; }
                }

                public class CheckBox : ContentControl
                {
                    public bool? IsChecked { get; set; }
                }

                public class RadioButton : ContentControl
                {
                    public bool? IsChecked { get; set; }
                    public string? GroupName { get; set; }
                }

                public class ComboBox : Control
                {
                    public int SelectedIndex { get; set; }
                    public object? SelectedItem { get; set; }
                }

                public class ListBox : Control
                {
                    public int SelectedIndex { get; set; }
                    public object? SelectedItem { get; set; }
                }

                public class ScrollViewer : ContentControl { }

                public class UserControl : ContentControl { }

                public partial class MainWindow : Window
                {
                }
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(source, path: "/tmp/WpfTestTypes.cs");
        var references = new[]
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Attribute).Assembly.Location),
        };

        return CSharpCompilation.Create(
            "WpfLanguageServerTests",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
    }
}

/// <summary>
/// Simple ICompilationProvider backed by a pre-built in-memory Compilation.
/// Mirrors the pattern used in AXSG's own LanguageService tests.
/// </summary>
internal sealed class InMemoryCompilationProvider : ICompilationProvider
{
    private readonly Compilation _compilation;

    public InMemoryCompilationProvider(Compilation compilation)
    {
        _compilation = compilation;
    }

    public Task<CompilationSnapshot> GetCompilationAsync(
        string filePath,
        string? workspaceRoot,
        CancellationToken cancellationToken) =>
        Task.FromResult(new CompilationSnapshot(
            ProjectPath: workspaceRoot,
            Project: null,
            Compilation: _compilation,
            Diagnostics: ImmutableArray<LanguageServiceDiagnostic>.Empty));

    public void Invalidate(string filePath) { }
    public void Dispose() { }
}

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

namespace XamlLanguageServer.Wpf.Tests;

/// <summary>
/// Verifies that <c>{Binding Path=}</c> completions are offered when the DataContext type is
/// declared via the WPF/Blend design-time hint <c>d:DataContext="{d:DesignInstance vm:T}"</c>.
/// </summary>
public sealed class WpfDesignInstanceBindingTests
{
    private const string PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private const string XamlNs         = "http://schemas.microsoft.com/winfx/2006/xaml";
    private const string BlendNs        = "http://schemas.microsoft.com/expression/blend/2008";
    private const string McNs           = "http://schemas.openxmlformats.org/markup-compatibility/2006";

    private const string TestFileUri  = "file:///tmp/LoginWindow.xaml";
    private const string WorkspaceRoot = "/tmp";

    private static readonly Lazy<Compilation> _compilation =
        new(CreateCompilation, LazyThreadSafetyMode.ExecutionAndPublication);

    private static XamlLanguageServiceEngine CreateEngine() =>
        new(new DesignInstanceInMemoryProvider(_compilation.Value), WpfFrameworkProfile.Instance);

    private static XamlLanguageServiceOptions Options() => new(WorkspaceRoot);

    // ------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------

    /// <summary>
    /// Typing <c>Command="{Binding Path=}</c> on a Button inside a Window decorated with
    /// <c>d:DataContext="{d:DesignInstance vm:LoginViewModel}"</c> should suggest
    /// <c>LoginCommand</c> and <c>Username</c> from the viewmodel.
    /// </summary>
    [Fact]
    public async Task BindingPath_WithDesignInstanceDataContext_SuggestsViewModelMembers()
    {
        using var engine = CreateEngine();

        // Cursor is inside Path= value: Command="{Binding Path=|}"
        const string xaml =
            $"<Window xmlns=\"{PresentationNs}\"\n" +
            $"        xmlns:x=\"{XamlNs}\"\n" +
            $"        xmlns:d=\"{BlendNs}\"\n" +
            $"        xmlns:mc=\"{McNs}\"\n" +
            "        xmlns:vm=\"clr-namespace:TestApp\"\n" +
            "        mc:Ignorable=\"d\"\n" +
            "        d:DataContext=\"{d:DesignInstance vm:LoginViewModel}\">\n" +
            "  <Grid>\n" +
            "    <Button Command=\"{Binding Path=}\" />\n" +
            "  </Grid>\n" +
            "</Window>";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);

        // Find the caret position: inside Path= value, just before the closing }
        var pathEqOffset = xaml.IndexOf("Path=}", StringComparison.Ordinal) + "Path=".Length;
        var (line, col) = OffsetToPosition(xaml, pathEqOffset);

        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(line, col),
            Options(),
            CancellationToken.None);

        Assert.NotEmpty(completions);
        Assert.Contains(completions, c => string.Equals(c.Label, "LoginCommand", StringComparison.Ordinal));
        Assert.Contains(completions, c => string.Equals(c.Label, "Username",     StringComparison.Ordinal));
    }

    /// <summary>
    /// Sanity check: when there is no <c>d:DataContext</c> and no <c>DataType</c>,
    /// binding path completions should be empty (not crash).
    /// </summary>
    [Fact]
    public async Task BindingPath_WithoutDataContext_ReturnsNoCompletions()
    {
        using var engine = CreateEngine();

        const string xaml =
            $"<Window xmlns=\"{PresentationNs}\" xmlns:x=\"{XamlNs}\">\n" +
            "  <Grid>\n" +
            "    <Button Command=\"{Binding Path=}\" />\n" +
            "  </Grid>\n" +
            "</Window>";

        await engine.OpenDocumentAsync(TestFileUri, xaml, 1, Options(), CancellationToken.None);

        var pathEqOffset = xaml.IndexOf("Path=}", StringComparison.Ordinal) + "Path=".Length;
        var (line, col) = OffsetToPosition(xaml, pathEqOffset);

        var completions = await engine.GetCompletionsAsync(
            TestFileUri,
            new SourcePosition(line, col),
            Options(),
            CancellationToken.None);

        // No DataContext type hint → no binding path completions
        Assert.DoesNotContain(completions, c =>
            string.Equals(c.Label, "LoginCommand", StringComparison.Ordinal) ||
            string.Equals(c.Label, "Username",     StringComparison.Ordinal));
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // Compilation factory
    // ------------------------------------------------------------------

    private static Compilation CreateCompilation()
    {
        const string source = """
            using System;
            using System.Windows.Input;

            // Map the WPF presentation namespace
            [assembly: System.Windows.Markup.XmlnsDefinition(
                "http://schemas.microsoft.com/winfx/2006/xaml/presentation",
                "TestWpf.Controls")]

            namespace System.Windows.Markup
            {
                [AttributeUsage(AttributeTargets.Assembly, AllowMultiple = true)]
                public sealed class XmlnsDefinitionAttribute : Attribute
                {
                    public XmlnsDefinitionAttribute(string xmlNamespace, string clrNamespace) { }
                }
            }

            namespace System.Windows.Input
            {
                public interface ICommand
                {
                    event EventHandler? CanExecuteChanged;
                    bool CanExecute(object? parameter);
                    void Execute(object? parameter);
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
                }
            }

            namespace System.Windows.Media
            {
                public class Brush { }
            }

            namespace TestWpf.Controls
            {
                using System.Windows;
                using System.Windows.Input;
                using System.Windows.Media;

                public class Control : FrameworkElement { public Brush? Background { get; set; } }
                public class ContentControl : Control  { public object? Content { get; set; } }
                public class Panel : FrameworkElement  { }
                public class Grid : Panel              { }

                public class Window : ContentControl
                {
                    public string Title { get; set; } = string.Empty;
                }

                public class Button : ContentControl
                {
                    public ICommand? Command { get; set; }
                }
            }

            namespace TestApp
            {
                using System.Windows.Input;

                public class LoginViewModel
                {
                    public string Username { get; set; } = string.Empty;
                    public ICommand LoginCommand { get; }
                    public LoginViewModel() => LoginCommand = null!;
                }
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(source, path: "/tmp/DesignInstanceTestTypes.cs");
        var references = new[]
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Attribute).Assembly.Location),
        };

        return CSharpCompilation.Create(
            "WpfDesignInstanceBindingTests",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
    }
}

internal sealed class DesignInstanceInMemoryProvider : ICompilationProvider
{
    private readonly Compilation _compilation;
    public DesignInstanceInMemoryProvider(Compilation compilation) => _compilation = compilation;

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

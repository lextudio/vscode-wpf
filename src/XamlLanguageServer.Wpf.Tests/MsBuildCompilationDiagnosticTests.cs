using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using XamlLanguageServer.Wpf.Wpf;
using XamlToCSharpGenerator.LanguageService;
using XamlToCSharpGenerator.LanguageService.Models;
using XamlToCSharpGenerator.LanguageService.Workspace;

namespace XamlLanguageServer.Wpf.Tests;

/// <summary>
/// Diagnostic tests that load the real sample project via MsBuildCompilationProvider
/// and verify that WPF framework assemblies and XmlnsDefinitionAttributes are present.
/// These tests reproduce the actual language server runtime conditions.
/// </summary>
public sealed class MsBuildCompilationDiagnosticTests : IDisposable
{
    // Resolve the sample project relative to the test assembly.
    // Test assembly is in: src/XamlLanguageServer.Wpf.Tests/bin/Debug/net10.0-windows/
    // Sample project is at: sample/sample.csproj
    private static readonly string SampleProjectPath = ResolveSampleProjectPath();
    private static readonly string SampleXamlPath = Path.Combine(
        Path.GetDirectoryName(SampleProjectPath)!, "MainWindow.xaml");

    private readonly MsBuildCompilationProvider _provider = new();

    public void Dispose() => _provider.Dispose();

    [Fact]
    public void SampleProject_Exists()
    {
        Assert.True(File.Exists(SampleProjectPath),
            $"Sample project not found at: {SampleProjectPath}");
    }

    [Fact]
    public async Task LoadCompilation_ReturnsNonNullCompilation()
    {
        var snapshot = await _provider.GetCompilationAsync(
            SampleXamlPath,
            Path.GetDirectoryName(SampleProjectPath),
            CancellationToken.None);

        // Log diagnostics for debugging
        if (!snapshot.Diagnostics.IsDefaultOrEmpty)
        {
            foreach (var d in snapshot.Diagnostics)
                Console.WriteLine($"[Diag] {d.Code} {d.Severity}: {d.Message}");
        }

        Assert.NotNull(snapshot.Compilation);
        Console.WriteLine($"Compilation loaded. Assembly: {snapshot.Compilation!.AssemblyName}");
    }

    [Fact]
    public async Task LoadCompilation_ContainsWpfFrameworkAssemblies()
    {
        var snapshot = await _provider.GetCompilationAsync(
            SampleXamlPath,
            Path.GetDirectoryName(SampleProjectPath),
            CancellationToken.None);

        Assert.NotNull(snapshot.Compilation);
        var compilation = snapshot.Compilation!;

        var referencedNames = compilation.SourceModule.ReferencedAssemblySymbols
            .Select(a => a.Identity.Name)
            .ToArray();

        Console.WriteLine($"Total referenced assemblies: {referencedNames.Length}");
        foreach (var name in referencedNames.Where(n =>
            n.Contains("Presentation", StringComparison.OrdinalIgnoreCase) ||
            n.Contains("WindowsBase", StringComparison.OrdinalIgnoreCase) ||
            n.Contains("System.Xaml", StringComparison.OrdinalIgnoreCase)))
        {
            Console.WriteLine($"  WPF-related: {name}");
        }

        // These are the critical WPF assemblies that carry XmlnsDefinitionAttribute
        Assert.Contains(referencedNames, n => n == "PresentationFramework");
        Assert.Contains(referencedNames, n => n == "PresentationCore");
        Assert.Contains(referencedNames, n => n == "WindowsBase");
    }

    [Fact]
    public async Task LoadCompilation_HasWpfXmlnsDefinitionAttributes()
    {
        var snapshot = await _provider.GetCompilationAsync(
            SampleXamlPath,
            Path.GetDirectoryName(SampleProjectPath),
            CancellationToken.None);

        Assert.NotNull(snapshot.Compilation);
        var compilation = snapshot.Compilation!;

        int wpfXmlnsDefCount = 0;
        string? sampleMapping = null;

        foreach (var assembly in compilation.SourceModule.ReferencedAssemblySymbols)
        {
            foreach (var attr in assembly.GetAttributes())
            {
                var attrName = attr.AttributeClass?.ToDisplayString();
                if (attrName != "System.Windows.Markup.XmlnsDefinitionAttribute")
                    continue;

                wpfXmlnsDefCount++;
                if (attr.ConstructorArguments.Length >= 2)
                {
                    var xmlNs = attr.ConstructorArguments[0].Value?.ToString();
                    var clrNs = attr.ConstructorArguments[1].Value?.ToString();
                    Console.WriteLine($"  XmlnsDef: {xmlNs} -> {clrNs} (in {assembly.Identity.Name})");
                    if (clrNs == "System.Windows.Controls")
                        sampleMapping = $"{xmlNs} -> {clrNs}";
                }
            }
        }

        Console.WriteLine($"Total WPF XmlnsDefinitionAttribute count: {wpfXmlnsDefCount}");

        // WPF assemblies declare many XmlnsDefinition mappings
        Assert.True(wpfXmlnsDefCount > 0,
            "No System.Windows.Markup.XmlnsDefinitionAttribute found in referenced assemblies. " +
            "MSBuildWorkspace may not be resolving WPF FrameworkReference.");

        Assert.NotNull(sampleMapping);
        Console.WriteLine($"System.Windows.Controls mapping: {sampleMapping}");
    }

    /// <summary>
    /// End-to-end test: use MsBuildCompilationProvider + WpfFrameworkProfile + real sample project.
    /// Type "&lt;" inside Grid of a full WPF document and verify Button appears in completions.
    /// This reproduces the exact runtime scenario of the language server.
    /// </summary>
    [Fact]
    public async Task EndToEnd_FullDocument_CompletionReturnsWpfTypes()
    {
        const string presentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
        const string xamlNs = "http://schemas.microsoft.com/winfx/2006/xaml";

        using var engine = new XamlLanguageServiceEngine(_provider, WpfFrameworkProfile.Instance);

        var xaml =
            $"<Window xmlns=\"{presentationNs}\"\n" +
            $"        xmlns:x=\"{xamlNs}\"\n" +
            "        Title=\"Test\" Width=\"800\" Height=\"450\">\n" +
            "  <Grid>\n" +
            "    <\n" +
            "  </Grid>\n" +
            "</Window>";

        var uri = "file:///" + SampleXamlPath.Replace('\\', '/');
        var workspaceRoot = Path.GetDirectoryName(SampleProjectPath);
        var options = new XamlLanguageServiceOptions(workspaceRoot);

        var openDiags = await engine.OpenDocumentAsync(uri, xaml, 1, options, CancellationToken.None);
        Console.WriteLine($"OpenDocument diagnostics: {openDiags.Length}");
        foreach (var d in openDiags)
            Console.WriteLine($"  [{d.Code}] {d.Severity}: {d.Message}");

        // cursor right after "<" on line 4
        var completions = await engine.GetCompletionsAsync(
            uri,
            new SourcePosition(4, 5),
            options,
            CancellationToken.None);

        Console.WriteLine($"Completions count: {completions.Length}");
        foreach (var c in completions.Take(20))
            Console.WriteLine($"  {c.Label} ({c.Detail})");

        Assert.NotEmpty(completions);
        Assert.Contains(completions, c => c.Label == "Button");
        Assert.Contains(completions, c => c.Label == "TextBlock");
        Assert.Contains(completions, c => c.Label == "Grid");
    }

    private static string ResolveSampleProjectPath()
    {
        // Walk up from the test assembly location to find the repo root
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "sample", "sample.csproj");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir);
        }

        // Fallback: assume we're running from the repo root
        return Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            "..", "..", "..", "..", "..",
            "sample", "sample.csproj"));
    }
}

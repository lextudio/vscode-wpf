using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using XamlToCSharpGenerator.WPF.Framework;
using XamlToCSharpGenerator.LanguageService;
using XamlToCSharpGenerator.LanguageService.Models;
using XamlToCSharpGenerator.LanguageService.Workspace;

namespace XamlLanguageServer.Wpf.Tests;

/// <summary>
/// Integration tests that spin up a dedicated temporary WPF project (written to
/// a temp directory at test startup) and drive <see cref="MsBuildCompilationProvider"/>
/// against it.  Nothing here depends on the repo's sample/ folder.
/// </summary>
public sealed class MsBuildCompilationDiagnosticTests : IDisposable
{
    // ── Fixture: temporary project written once per test class ─────────────────
    private static readonly string TempProjectDir = CreateTempWpfProject();
    private static readonly string TempProjectPath  = Path.Combine(TempProjectDir, "WpfTest.csproj");
    private static readonly string TempMainXaml     = Path.Combine(TempProjectDir, "MainWindow.xaml");

    private readonly MsBuildCompilationProvider _provider = new();

    public void Dispose() => _provider.Dispose();

    // ── Helpers ────────────────────────────────────────────────────────────────

    private static string CreateTempWpfProject()
    {
        var dir = Path.Combine(Path.GetTempPath(), "wpf-ls-test-" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);

        // Minimal WPF project — same structure the SDK needs for UseWPF=true.
        File.WriteAllText(Path.Combine(dir, "WpfTest.csproj"), """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>WinExe</OutputType>
                <TargetFramework>net6.0-windows</TargetFramework>
                <EnableWindowsTargeting>true</EnableWindowsTargeting>
                <Nullable>enable</Nullable>
                <ImplicitUsings>enable</ImplicitUsings>
                <UseWPF>true</UseWPF>
              </PropertyGroup>
            </Project>
            """);

        // App.xaml — required by WPF SDK when UseWPF=true
        File.WriteAllText(Path.Combine(dir, "App.xaml"), """
            <Application xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                         xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                         x:Class="WpfTest.App">
            </Application>
            """);
        File.WriteAllText(Path.Combine(dir, "App.xaml.cs"), """
            namespace WpfTest;
            public partial class App : System.Windows.Application { }
            """);

        // MainWindow.xaml — the file the tests open
        File.WriteAllText(Path.Combine(dir, "MainWindow.xaml"), """
            <Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                    x:Class="WpfTest.MainWindow"
                    Title="MainWindow" Width="800" Height="450">
              <Grid>
              </Grid>
            </Window>
            """);
        File.WriteAllText(Path.Combine(dir, "MainWindow.xaml.cs"), """
            namespace WpfTest;
            public partial class MainWindow : System.Windows.Window
            {
                public MainWindow() { InitializeComponent(); }
            }
            """);

        // Run dotnet restore so MSBuildWorkspace can open the project without errors.
        var restore = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = "dotnet",
            Arguments = $"restore \"{Path.Combine(dir, "WpfTest.csproj")}\" --verbosity quiet",
            RedirectStandardOutput = true,
            RedirectStandardError  = true,
            UseShellExecute        = false,
        })!;
        restore.WaitForExit(60_000);

        return dir;
    }

    // ── Tests ──────────────────────────────────────────────────────────────────

    [Fact]
    public void TempProject_Exists()
    {
        Assert.True(File.Exists(TempProjectPath),
            $"Temp project not created at: {TempProjectPath}");
        Assert.True(File.Exists(TempMainXaml),
            $"Temp MainWindow.xaml not created at: {TempMainXaml}");
    }

    [Fact]
    public async Task LoadCompilation_ReturnsNonNullCompilation()
    {
        var snapshot = await _provider.GetCompilationAsync(
            TempMainXaml,
            TempProjectDir,
            CancellationToken.None);

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
            TempMainXaml,
            TempProjectDir,
            CancellationToken.None);

        Assert.NotNull(snapshot.Compilation);
        var referencedNames = snapshot.Compilation!.SourceModule.ReferencedAssemblySymbols
            .Select(a => a.Identity.Name)
            .ToArray();

        Console.WriteLine($"Total referenced assemblies: {referencedNames.Length}");
        foreach (var name in referencedNames.Where(n =>
            n.Contains("Presentation", StringComparison.OrdinalIgnoreCase) ||
            n.Contains("WindowsBase",  StringComparison.OrdinalIgnoreCase) ||
            n.Contains("System.Xaml",  StringComparison.OrdinalIgnoreCase)))
        {
            Console.WriteLine($"  WPF-related: {name}");
        }

        Assert.Contains(referencedNames, n => n == "PresentationFramework");
        Assert.Contains(referencedNames, n => n == "PresentationCore");
        Assert.Contains(referencedNames, n => n == "WindowsBase");
    }

    [Fact]
    public async Task LoadCompilation_HasWpfXmlnsDefinitionAttributes()
    {
        var snapshot = await _provider.GetCompilationAsync(
            TempMainXaml,
            TempProjectDir,
            CancellationToken.None);

        Assert.NotNull(snapshot.Compilation);
        var compilation = snapshot.Compilation!;

        int count = 0;
        string? controlsMapping = null;

        foreach (var assembly in compilation.SourceModule.ReferencedAssemblySymbols)
        {
            foreach (var attr in assembly.GetAttributes())
            {
                if (attr.AttributeClass?.ToDisplayString() != "System.Windows.Markup.XmlnsDefinitionAttribute")
                    continue;
                count++;
                if (attr.ConstructorArguments.Length >= 2)
                {
                    var xmlNs = attr.ConstructorArguments[0].Value?.ToString();
                    var clrNs = attr.ConstructorArguments[1].Value?.ToString();
                    Console.WriteLine($"  XmlnsDef: {xmlNs} -> {clrNs} (in {assembly.Identity.Name})");
                    if (clrNs == "System.Windows.Controls")
                        controlsMapping = $"{xmlNs} -> {clrNs}";
                }
            }
        }

        Console.WriteLine($"Total WPF XmlnsDefinitionAttribute count: {count}");
        Assert.True(count > 0, "No XmlnsDefinitionAttribute found — WPF FrameworkReference not resolved.");
        Assert.NotNull(controlsMapping);
    }

    /// <summary>
    /// End-to-end: open a well-formed WPF document with cursor after a bare
    /// "&lt;" inside Grid and assert Button/TextBlock/Grid appear in completions.
    /// The XAML is well-formed XML; the incomplete tag is represented by a
    /// placeholder element so the XML parser does not reject the document.
    /// </summary>
    [Fact]
    public async Task EndToEnd_FullDocument_CompletionReturnsWpfTypes()
    {
        const string presentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
        const string xamlNs         = "http://schemas.microsoft.com/winfx/2006/xaml";

        using var engine = new XamlLanguageServiceEngine(_provider, WpfFrameworkProfile.Instance);

        // Use a document with a bare "<" on line 4 (0-based) to trigger element-name completion.
        // The XML parser will report AXSG0001 but the completion engine uses text-based
        // cursor analysis, which is independent of XML validity.
        var xaml =
            $"<Window xmlns=\"{presentationNs}\"\n" +
            $"        xmlns:x=\"{xamlNs}\"\n" +
            "        Title=\"Test\" Width=\"800\" Height=\"450\">\n" +
            "  <Grid>\n" +
            "    <\n" +
            "  </Grid>\n" +
            "</Window>";

        var uri = new Uri(TempMainXaml).AbsoluteUri;
        var workspaceRoot = TempProjectDir;
        var options = new XamlLanguageServiceOptions(workspaceRoot);

        var openDiags = await engine.OpenDocumentAsync(uri, xaml, 1, options, CancellationToken.None);
        Console.WriteLine($"OpenDocument diagnostics: {openDiags.Length}");
        foreach (var d in openDiags)
            Console.WriteLine($"  [{d.Code}] {d.Severity}: {d.Message}");

        // cursor at line 4 (0-based) = "    <", col 5 = right after "<" → empty prefix → all elements
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
}

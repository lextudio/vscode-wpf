using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using XamlToCSharpGenerator.LanguageService.Models;
using XamlToCSharpGenerator.LanguageService.Workspace;

namespace XamlLanguageServer.Wpf.Diagnostics;

/// <summary>
/// Wraps an ICompilationProvider to log diagnostic information to stderr.
/// Stderr is safe to use — LSP communication goes over stdin/stdout.
/// </summary>
internal sealed class DiagnosticCompilationProvider : ICompilationProvider
{
    private readonly ICompilationProvider _inner;

    public DiagnosticCompilationProvider(ICompilationProvider inner)
    {
        _inner = inner;
    }

    public async Task<CompilationSnapshot> GetCompilationAsync(
        string filePath, string? workspaceRoot, CancellationToken cancellationToken)
    {
        Log($"GetCompilationAsync: filePath={filePath}, workspaceRoot={workspaceRoot}");

        var snapshot = await _inner.GetCompilationAsync(filePath, workspaceRoot, cancellationToken)
            .ConfigureAwait(false);

        Log($"  ProjectPath={snapshot.ProjectPath ?? "(null)"}");
        Log($"  Project={snapshot.Project?.Name ?? "(null)"}");
        Log($"  Compilation={(snapshot.Compilation is not null ? "loaded" : "NULL")}");

        if (snapshot.Compilation is not null)
        {
            var compilation = snapshot.Compilation;
            var referencedAssemblies = compilation.SourceModule.ReferencedAssemblySymbols;
            Log($"  ReferencedAssemblies.Count={referencedAssemblies.Length}");

            // Check for WPF framework assemblies
            var wpfAssemblies = referencedAssemblies
                .Where(a => a.Identity.Name.StartsWith("PresentationFramework", StringComparison.Ordinal) ||
                            a.Identity.Name.StartsWith("PresentationCore", StringComparison.Ordinal) ||
                            a.Identity.Name.StartsWith("WindowsBase", StringComparison.Ordinal))
                .Select(a => a.Identity.Name)
                .ToArray();
            Log($"  WPF assemblies found: [{string.Join(", ", wpfAssemblies)}]");

            // Check for XmlnsDefinitionAttribute in referenced assemblies
            int xmlnsDefCount = 0;
            int wpfXmlnsDefCount = 0;
            foreach (var assembly in referencedAssemblies)
            {
                foreach (var attr in assembly.GetAttributes())
                {
                    var attrName = attr.AttributeClass?.ToDisplayString();
                    if (attrName == "System.Windows.Markup.XmlnsDefinitionAttribute")
                    {
                        wpfXmlnsDefCount++;
                        if (wpfXmlnsDefCount <= 5)
                        {
                            var xmlNs = attr.ConstructorArguments.Length > 0 ? attr.ConstructorArguments[0].Value?.ToString() : "?";
                            var clrNs = attr.ConstructorArguments.Length > 1 ? attr.ConstructorArguments[1].Value?.ToString() : "?";
                            Log($"    WPF XmlnsDef: {xmlNs} -> {clrNs}");
                        }
                    }
                    else if (attrName == "Avalonia.Metadata.XmlnsDefinitionAttribute")
                    {
                        xmlnsDefCount++;
                    }
                }
            }
            Log($"  Avalonia XmlnsDefinitionAttribute count: {xmlnsDefCount}");
            Log($"  WPF XmlnsDefinitionAttribute count: {wpfXmlnsDefCount}");

            // Log source assembly types (what ends up in fallback)
            var sourceTypes = compilation.Assembly.GlobalNamespace
                .GetNamespaceMembers()
                .SelectMany(ns => ns.GetTypeMembers())
                .Where(t => t.DeclaredAccessibility == Accessibility.Public && !t.IsAbstract)
                .Select(t => t.ToDisplayString())
                .ToArray();
            Log($"  Source assembly public types: [{string.Join(", ", sourceTypes)}]");
        }

        if (!snapshot.Diagnostics.IsDefaultOrEmpty)
        {
            foreach (var diag in snapshot.Diagnostics)
            {
                Log($"  Diagnostic [{diag.Code}] {diag.Severity}: {diag.Message}");
            }
        }

        return snapshot;
    }

    public void Invalidate(string filePath)
    {
        Log($"Invalidate: {filePath}");
        _inner.Invalidate(filePath);
    }

    public void Dispose()
    {
        _inner.Dispose();
    }

    private static void Log(string message)
    {
        Console.Error.WriteLine($"[WPF-LS Diag] {message}");
    }
}

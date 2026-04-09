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
/// Wraps an <see cref="ICompilationProvider"/> to log diagnostic information to
/// stderr.  Stderr is safe to use — LSP communication goes over stdin/stdout.
///
/// <para>
/// The expensive per-assembly attribute scan (checking for
/// <c>XmlnsDefinitionAttribute</c>) runs asynchronously after the snapshot is
/// returned to the caller.  It never blocks completion or hover requests.
/// </para>
/// </summary>
internal sealed class DiagnosticCompilationProvider : ICompilationProvider
{
    private readonly ICompilationProvider _inner;

    // Track which project paths have already had their full compilation detail logged
    // so the expensive per-assembly scan only runs once per project.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, bool> _loggedProjects =
        new(StringComparer.OrdinalIgnoreCase);

    public DiagnosticCompilationProvider(ICompilationProvider inner)
    {
        _inner = inner;
    }

    public async Task<CompilationSnapshot> GetCompilationAsync(
        string filePath, string? workspaceRoot, CancellationToken cancellationToken)
    {
        var snapshot = await _inner.GetCompilationAsync(filePath, workspaceRoot, cancellationToken)
            .ConfigureAwait(false);

        // Log compilation-level details only once per unique project path.
        var key = snapshot.ProjectPath ?? workspaceRoot ?? filePath;
        if (_loggedProjects.TryAdd(key, true))
        {
            Log($"Compilation loaded: ProjectPath={snapshot.ProjectPath ?? "(null)"}, " +
                $"Project={snapshot.Project?.Name ?? "(null)"}, " +
                $"HasCompilation={snapshot.Compilation is not null}");

            if (!snapshot.Diagnostics.IsDefaultOrEmpty)
            {
                foreach (var diag in snapshot.Diagnostics)
                {
                    Log($"  Diagnostic [{diag.Code}] {diag.Severity}: {diag.Message}");
                }
            }

            if (snapshot.Compilation is not null)
            {
                var compilationForLog = snapshot.Compilation;
                _ = Task.Run(() => LogCompilationDetails(compilationForLog));
            }
        }

        return snapshot;
    }

    public void Invalidate(string filePath)
    {
        Log($"Invalidate: {filePath}");
        _loggedProjects.Clear();
        _inner.Invalidate(filePath);
    }

    public void Dispose()
    {
        _inner.Dispose();
    }

    // -------------------------------------------------------------------------
    // Async diagnostic logging — runs after the compilation is returned
    // -------------------------------------------------------------------------

    private static void LogCompilationDetails(Compilation compilation)
    {
        try
        {
            var referencedAssemblies = compilation.SourceModule.ReferencedAssemblySymbols;
            Log($"[async scan] ReferencedAssemblies.Count={referencedAssemblies.Length}");

            var wpfAssemblies = referencedAssemblies
                .Where(a => a.Identity.Name.StartsWith("PresentationFramework", StringComparison.Ordinal) ||
                            a.Identity.Name.StartsWith("PresentationCore", StringComparison.Ordinal) ||
                            a.Identity.Name.StartsWith("WindowsBase", StringComparison.Ordinal))
                .Select(a => a.Identity.Name)
                .ToArray();
            Log($"[async scan] WPF assemblies found: [{string.Join(", ", wpfAssemblies)}]");

            // Walk every referenced assembly looking for XmlnsDefinitionAttribute.
            // This triggers Roslyn metadata loading and can be slow — which is
            // why it runs on a background thread.
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
                            var xmlNs = attr.ConstructorArguments.Length > 0
                                ? attr.ConstructorArguments[0].Value?.ToString() : "?";
                            var clrNs = attr.ConstructorArguments.Length > 1
                                ? attr.ConstructorArguments[1].Value?.ToString() : "?";
                            Log($"[async scan]   WPF XmlnsDef: {xmlNs} -> {clrNs}");
                        }
                    }
                    else if (attrName == "Avalonia.Metadata.XmlnsDefinitionAttribute")
                    {
                        xmlnsDefCount++;
                    }
                }
            }

            Log($"[async scan] Avalonia XmlnsDefinitionAttribute count: {xmlnsDefCount}");
            Log($"[async scan] WPF XmlnsDefinitionAttribute count: {wpfXmlnsDefCount}");

            var sourceTypes = compilation.Assembly.GlobalNamespace
                .GetNamespaceMembers()
                .SelectMany(ns => ns.GetTypeMembers())
                .Where(t => t.DeclaredAccessibility == Accessibility.Public && !t.IsAbstract)
                .Select(t => t.ToDisplayString())
                .ToArray();
            Log($"[async scan] Source assembly public types: [{string.Join(", ", sourceTypes)}]");
        }
        catch (Exception ex)
        {
            Log($"[async scan] Failed: {ex.Message}");
        }
    }

    private static void Log(string message)
    {
        Console.Error.WriteLine($"[WPF-LS Diag] {message}");
    }
}

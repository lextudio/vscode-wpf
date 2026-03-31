using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using XamlToCSharpGenerator.LanguageService.Models;
using XamlToCSharpGenerator.LanguageService.Workspace;

namespace XamlLanguageServer.Wpf.Workspace;

/// <summary>
/// WPF-specific factory for the Tier-1 (fast) compilation snapshot used by
/// <see cref="TieredCompilationProvider"/>.
///
/// <para>
/// Builds a lightweight Roslyn compilation from the WPF framework assemblies
/// in the <c>Microsoft.WindowsDesktop.App</c> shared framework, so the editor
/// can offer standard WPF element and attribute completions immediately —
/// without waiting for MSBuild to evaluate the user's project.
/// </para>
///
/// <para>
/// Usage: call <see cref="BuildFastSnapshot"/> once at server startup and pass
/// the result (along with the full <see cref="ICompilationProvider"/>) to
/// <see cref="TieredCompilationProvider"/>.
/// </para>
/// </summary>
internal static class WpfFastCompilationProvider
{
    /// <summary>
    /// Builds the WPF-core Tier-1 snapshot.  Returns <see langword="null"/>
    /// if the <c>Microsoft.WindowsDesktop.App</c> runtime cannot be found.
    /// </summary>
    public static CompilationSnapshot? BuildFastSnapshot()
    {
        try
        {
            var references = BuildWpfCoreReferences();
            if (references.Count == 0)
            {
                Console.Error.WriteLine(
                    "[WPF-LS] WPF core compilation skipped — no references resolved.");
                return null;
            }

            var compilation = CSharpCompilation.Create(
                assemblyName: "WpfCore",
                options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary),
                references: references);

            Console.Error.WriteLine(
                $"[WPF-LS] WPF core (Tier-1) compilation built with {references.Count} references.");

            return new CompilationSnapshot(
                ProjectPath: null,
                Project: null,
                Compilation: compilation,
                Diagnostics: ImmutableArray<LanguageServiceDiagnostic>.Empty);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[WPF-LS] Failed to build WPF core compilation: {ex.Message}");
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Reference resolution
    // -------------------------------------------------------------------------

    /// <summary>
    /// Resolves <see cref="MetadataReference"/> objects for the WPF core
    /// compilation without loading WPF assemblies into the CLR.
    ///
    /// <para>
    /// References come from two sources:
    /// <list type="bullet">
    ///   <item>
    ///     <c>Microsoft.WindowsDesktop.App</c> shared framework — the four WPF
    ///     assemblies that carry <c>XmlnsDefinitionAttribute</c> entries the
    ///     XAML semantic binder needs to resolve element names:
    ///     PresentationFramework, PresentationCore, WindowsBase, System.Xaml.
    ///   </item>
    ///   <item>
    ///     <c>Microsoft.NETCore.App</c> shared framework — BCL assemblies
    ///     required for Roslyn to resolve base types across the WPF hierarchy.
    ///   </item>
    /// </list>
    /// Roslyn reads metadata directly from the files without a CLR assembly load.
    /// </para>
    /// </summary>
    private static IReadOnlyList<MetadataReference> BuildWpfCoreReferences()
    {
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var refs = new List<MetadataReference>();

        void TryAdd(string path)
        {
            if (File.Exists(path) && visited.Add(path))
            {
                refs.Add(MetadataReference.CreateFromFile(path));
            }
        }

        // ── NETCore.App (BCL) ────────────────────────────────────────────────
        // RuntimeEnvironment.GetRuntimeDirectory() returns the path of the
        // currently executing NETCore.App shared framework, e.g.:
        //   C:\Program Files\dotnet\shared\Microsoft.NETCore.App\10.0.5\
        var coreRuntimeDir =
            System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();

        foreach (var coreAssembly in new[]
        {
            "System.Runtime.dll",
            "System.Collections.dll",
            "System.ObjectModel.dll",
            "System.ComponentModel.dll",
            "System.ComponentModel.TypeConverter.dll",
            "netstandard.dll",
        })
        {
            TryAdd(Path.Combine(coreRuntimeDir, coreAssembly));
        }

        // ── Microsoft.WindowsDesktop.App (WPF) ──────────────────────────────
        // The shared root is two levels above the runtime directory:
        //   …\dotnet\shared\Microsoft.NETCore.App\10.0.5\  →  …\dotnet\shared\
        var trimmed = coreRuntimeDir.TrimEnd(
            Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var sharedRoot = Path.GetDirectoryName(Path.GetDirectoryName(trimmed));

        var desktopRoot = sharedRoot is not null
            ? Path.Combine(sharedRoot, "Microsoft.WindowsDesktop.App")
            : null;

        string? desktopDir = null;
        if (desktopRoot is not null && Directory.Exists(desktopRoot))
        {
            // Prefer a version that matches our major runtime version to avoid
            // type-identity mismatches between the BCL and WPF assemblies.
            var runtimeVersion = Path.GetFileName(trimmed);
            var majorPrefix = runtimeVersion.Split('.')[0] + ".";

            desktopDir = Directory.GetDirectories(desktopRoot)
                .Where(d => Path.GetFileName(d)
                    .StartsWith(majorPrefix, StringComparison.Ordinal))
                .OrderByDescending(d => d, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault()
                ?? Directory.GetDirectories(desktopRoot)
                    .OrderByDescending(d => d, StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
        }

        if (desktopDir is not null)
        {
            foreach (var wpfAssembly in new[]
            {
                "PresentationFramework.dll",
                "PresentationCore.dll",
                "WindowsBase.dll",
                "System.Xaml.dll",
            })
            {
                TryAdd(Path.Combine(desktopDir, wpfAssembly));
            }

            Console.Error.WriteLine($"[WPF-LS] WPF framework dir: {desktopDir}");
        }
        else
        {
            Console.Error.WriteLine(
                "[WPF-LS] WARNING: Microsoft.WindowsDesktop.App not found — " +
                "Tier-1 WPF core compilation will have no WPF type metadata.");
        }

        return refs;
    }
}

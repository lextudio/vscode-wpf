using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using XamlToCSharpGenerator.LanguageService.Symbols;
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
    private const string WpfPresentationXmlNamespace =
        "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private static readonly JsonSerializerOptions CacheJsonOptions = new()
    {
        WriteIndented = false
    };

    /// <summary>
    /// Builds the WPF-core Tier-1 snapshot.  Returns <see langword="null"/>
    /// if the <c>Microsoft.WindowsDesktop.App</c> runtime cannot be found.
    /// </summary>
    public static CompilationSnapshot? BuildFastSnapshot()
    {
        try
        {
            var referencesResult = BuildWpfCoreReferences();
            var references = referencesResult.References;
            if (references.Count == 0)
            {
                Console.Error.WriteLine(
                    "[WPF-LS] WPF core compilation skipped — no references resolved.");
                return null;
            }

            var compilation = CSharpCompilation.Create(
                assemblyName: "WpfCore",
                options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary),
                references: references,
                syntaxTrees: new[]
                {
                    CSharpSyntaxTree.ParseText(
                        SourceText.From(BuildSyntheticWpfXmlnsMapSource()),
                        path: "WpfCore.XmlnsMap.g.cs")
                });

            Console.Error.WriteLine(
                $"[WPF-LS] WPF core (Tier-1) compilation built with {references.Count} references.");

            var cacheInfo = TryPrimeTypeIndexFromDisk(compilation, referencesResult.ReferencePaths);
            if (cacheInfo is not null)
            {
                Console.Error.WriteLine(cacheInfo);
            }

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

    public static string PersistTypeIndexToDisk(Compilation compilation)
    {
        try
        {
            var index = AvaloniaTypeIndex.Create(compilation);
            var exported = index.ExportXmlNamespaceTypes(new[] { WpfPresentationXmlNamespace });
            if (!exported.TryGetValue(WpfPresentationXmlNamespace, out var presentationTypes) || presentationTypes.IsDefaultOrEmpty)
            {
                return "[WPF-LS] Tier-1 metadata cache skipped: no WPF presentation types to persist.";
            }

            var referencePaths = compilation.References
                .OfType<PortableExecutableReference>()
                .Select(static r => r.FilePath)
                .Where(static p => !string.IsNullOrWhiteSpace(p) && File.Exists(p))
                .Select(static p => p!)
                .ToImmutableArray();

            var key = ComputeCacheKey(referencePaths);
            if (string.IsNullOrWhiteSpace(key))
            {
                return "[WPF-LS] Tier-1 metadata cache skipped: could not compute cache key.";
            }

            var payload = new Tier1CachePayload
            {
                Version = 1,
                Key = key,
                CreatedUtc = DateTimeOffset.UtcNow.ToString("O"),
                XmlNamespaces = new[]
                {
                    new CachedNamespace
                    {
                        XmlNamespace = WpfPresentationXmlNamespace,
                        Types = presentationTypes.Select(ToCachedType).ToArray()
                    }
                }
            };

            var filePath = GetCacheFilePath();
            Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
            File.WriteAllText(filePath, JsonSerializer.Serialize(payload, CacheJsonOptions), Encoding.UTF8);
            return $"[WPF-LS] Tier-1 metadata cache refreshed ({presentationTypes.Length} types) at {filePath}";
        }
        catch (Exception ex)
        {
            return $"[WPF-LS] Tier-1 metadata cache persist failed: {ex.Message}";
        }
    }

    private static string BuildSyntheticWpfXmlnsMapSource()
    {
        // Some runtime/reference packs do not reliably expose enough WPF
        // XmlnsDefinitionAttribute metadata during Tier-1 startup. Seed a
        // minimal mapping so core WPF control completions (Button/Grid/etc.)
        // are always available while MSBuild Tier-2 is loading.
        var namespaces = new[]
        {
            "System.Windows",
            "System.Windows.Controls",
            "System.Windows.Controls.Primitives",
            "System.Windows.Data",
            "System.Windows.Documents",
            "System.Windows.Input",
            "System.Windows.Media",
            "System.Windows.Navigation",
            "System.Windows.Shapes",
        };

        var lines = new List<string>(namespaces.Length + 1);
        foreach (var clrNs in namespaces)
        {
            lines.Add(
                $"[assembly: System.Windows.Markup.XmlnsDefinition(\"{WpfPresentationXmlNamespace}\", \"{clrNs}\")]");
        }

        lines.Add("internal static class __WpfTier1XmlnsMapAnchor { }");
        return string.Join(Environment.NewLine, lines);
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
    private static WpfReferenceBuildResult BuildWpfCoreReferences()
    {
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var refs = new List<MetadataReference>();
        var refPaths = new List<string>();

        void TryAdd(string path)
        {
            if (File.Exists(path) && visited.Add(path))
            {
                refs.Add(MetadataReference.CreateFromFile(path));
                refPaths.Add(path);
            }
        }

        // Runtime directory example:
        //   C:\Program Files\dotnet\shared\Microsoft.NETCore.App\10.0.5\
        var coreRuntimeDir =
            System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        var trimmed = coreRuntimeDir.TrimEnd(
            Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var sharedRoot = Path.GetDirectoryName(Path.GetDirectoryName(trimmed));
        var dotnetRoot = sharedRoot is not null
            ? Path.GetDirectoryName(sharedRoot)
            : null;

        var coreRefDir = FindLatestPackRefDir(dotnetRoot, "Microsoft.NETCore.App.Ref");
        var desktopRefDir = FindLatestPackRefDir(dotnetRoot, "Microsoft.WindowsDesktop.App.Ref");

        // Prefer reference packs when available (works even without desktop runtime install).
        var bclDir = coreRefDir ?? coreRuntimeDir;
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
            TryAdd(Path.Combine(bclDir, coreAssembly));
        }

        string? desktopDir = desktopRefDir;
        if (desktopDir is null && sharedRoot is not null)
        {
            var desktopRoot = Path.Combine(sharedRoot, "Microsoft.WindowsDesktop.App");
            desktopDir = FindLatestVersionDir(desktopRoot);
        }

        if (desktopDir is null)
        {
            Console.Error.WriteLine(
                "[WPF-LS] WARNING: Microsoft.WindowsDesktop.App references not found in packs/ or shared runtime.");
        }
        else
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
            Console.Error.WriteLine($"[WPF-LS] WPF reference dir: {desktopDir}");
        }

        return new WpfReferenceBuildResult(refs, refPaths);
    }

    private static string? TryPrimeTypeIndexFromDisk(Compilation compilation, IReadOnlyList<string> referencePaths)
    {
        try
        {
            var key = ComputeCacheKey(referencePaths);
            if (string.IsNullOrWhiteSpace(key))
            {
                return null;
            }

            var filePath = GetCacheFilePath();
            if (!File.Exists(filePath))
            {
                return $"[WPF-LS] Tier-1 metadata cache miss: no cache file at {filePath}.";
            }

            var payload = JsonSerializer.Deserialize<Tier1CachePayload>(File.ReadAllText(filePath), CacheJsonOptions);
            if (payload is null || payload.Version != 1 || !string.Equals(payload.Key, key, StringComparison.Ordinal))
            {
                return "[WPF-LS] Tier-1 metadata cache miss: cache key mismatch (SDK/reference pack changed).";
            }

            var mapBuilder = ImmutableDictionary.CreateBuilder<string, ImmutableArray<AvaloniaTypeInfo>>(StringComparer.Ordinal);
            foreach (var ns in payload.XmlNamespaces ?? Array.Empty<CachedNamespace>())
            {
                if (string.IsNullOrWhiteSpace(ns.XmlNamespace))
                {
                    continue;
                }

                var types = (ns.Types ?? Array.Empty<CachedType>())
                    .Select(t => new AvaloniaTypeInfo(
                        XmlTypeName: t.XmlTypeName ?? string.Empty,
                        FullTypeName: t.FullTypeName ?? string.Empty,
                        XmlNamespace: ns.XmlNamespace!,
                        ClrNamespace: t.ClrNamespace ?? string.Empty,
                        AssemblyName: t.AssemblyName ?? string.Empty,
                        Properties: (t.Properties ?? Array.Empty<CachedProperty>())
                            .Select(p => new AvaloniaPropertyInfo(
                                Name: p.Name ?? string.Empty,
                                TypeName: p.TypeName ?? string.Empty,
                                IsSettable: p.IsSettable,
                                IsAttached: p.IsAttached,
                                SourceLocation: null))
                            .ToImmutableArray(),
                        Summary: t.Summary ?? string.Empty,
                        SourceLocation: null,
                        PseudoClasses: ImmutableArray<AvaloniaPseudoClassInfo>.Empty))
                    .ToImmutableArray();

                if (!types.IsDefaultOrEmpty)
                {
                    mapBuilder[ns.XmlNamespace!] = types;
                }
            }

            var map = mapBuilder.ToImmutable();
            if (map.IsEmpty)
            {
                return "[WPF-LS] Tier-1 metadata cache miss: cache file contained no usable type data.";
            }

            AvaloniaTypeIndex.TryPrimeCache(compilation, map);
            var count = map.TryGetValue(WpfPresentationXmlNamespace, out var wpfTypes) ? wpfTypes.Length : 0;
            return $"[WPF-LS] Tier-1 metadata cache hit: loaded {count} WPF types from disk.";
        }
        catch (Exception ex)
        {
            return $"[WPF-LS] Tier-1 metadata cache read failed: {ex.Message}";
        }
    }

    private static string GetCacheFilePath()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var root = Path.Combine(local, "LeXtudio", "vscode-wpf");
        return Path.Combine(root, "wpf-ls-tier1-cache.json");
    }

    private static string ComputeCacheKey(IReadOnlyList<string> referencePaths)
    {
        if (referencePaths is null || referencePaths.Count == 0)
        {
            return string.Empty;
        }

        using var sha = SHA256.Create();
        var ordered = referencePaths
            .Where(static p => !string.IsNullOrWhiteSpace(p) && File.Exists(p))
            .OrderBy(static p => p, StringComparer.OrdinalIgnoreCase);

        var sb = new StringBuilder(4096);
        foreach (var path in ordered)
        {
            var info = new FileInfo(path);
            sb.Append(path).Append('|')
              .Append(info.Length).Append('|')
              .Append(info.LastWriteTimeUtc.Ticks).AppendLine();
        }

        var bytes = Encoding.UTF8.GetBytes(sb.ToString());
        var hash = sha.ComputeHash(bytes);
        return Convert.ToHexString(hash);
    }

    private static CachedType ToCachedType(AvaloniaTypeInfo typeInfo)
    {
        return new CachedType
        {
            XmlTypeName = typeInfo.XmlTypeName,
            FullTypeName = typeInfo.FullTypeName,
            ClrNamespace = typeInfo.ClrNamespace,
            AssemblyName = typeInfo.AssemblyName,
            Summary = typeInfo.Summary,
            Properties = typeInfo.Properties
                .Select(p => new CachedProperty
                {
                    Name = p.Name,
                    TypeName = p.TypeName,
                    IsSettable = p.IsSettable,
                    IsAttached = p.IsAttached,
                })
                .ToArray(),
        };
    }

    private static string? FindLatestPackRefDir(string? dotnetRoot, string packName)
    {
        if (string.IsNullOrWhiteSpace(dotnetRoot))
        {
            return null;
        }

        var packRoot = Path.Combine(dotnetRoot, "packs", packName);
        if (!Directory.Exists(packRoot))
        {
            return null;
        }

        var versionDir = FindLatestVersionDir(packRoot);
        if (versionDir is null)
        {
            return null;
        }

        var refRoot = Path.Combine(versionDir, "ref");
        if (!Directory.Exists(refRoot))
        {
            return null;
        }

        return Directory.GetDirectories(refRoot)
            .OrderByDescending(static d => d, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
    }

    private static string? FindLatestVersionDir(string root)
    {
        if (!Directory.Exists(root))
        {
            return null;
        }

        return Directory.GetDirectories(root)
            .OrderByDescending(static d => d, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
    }

    private sealed record WpfReferenceBuildResult(
        IReadOnlyList<MetadataReference> References,
        IReadOnlyList<string> ReferencePaths);

    private sealed class Tier1CachePayload
    {
        public int Version { get; set; }
        public string? Key { get; set; }
        public string? CreatedUtc { get; set; }
        public CachedNamespace[]? XmlNamespaces { get; set; }
    }

    private sealed class CachedNamespace
    {
        public string? XmlNamespace { get; set; }
        public CachedType[]? Types { get; set; }
    }

    private sealed class CachedType
    {
        public string? XmlTypeName { get; set; }
        public string? FullTypeName { get; set; }
        public string? ClrNamespace { get; set; }
        public string? AssemblyName { get; set; }
        public string? Summary { get; set; }
        public CachedProperty[]? Properties { get; set; }
    }

    private sealed class CachedProperty
    {
        public string? Name { get; set; }
        public string? TypeName { get; set; }
        public bool IsSettable { get; set; }
        public bool IsAttached { get; set; }
    }
}

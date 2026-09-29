using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using XamlToCSharpGenerator.LanguageService.Workspace.Tier1;

namespace XamlLanguageServer.Wpf.Workspace;

/// <summary>Microsoft WPF: the four assemblies of <c>Microsoft.WindowsDesktop.App</c> that carry the
/// presentation types, from the reference pack (NuGet cache on macOS/Linux, SDK packs/ on
/// Windows), falling back to the shared runtime's implementation assemblies.</summary>
internal sealed class WpfTier1ReferenceSet : ITier1ReferenceSet
{
    public static WpfTier1ReferenceSet Instance { get; } = new();

    // Microsoft WPF. LibreWPF, the same markup over different assemblies, has its own server.
    public string Name => "WPF";

    public IReadOnlyList<string> AnchorTypes { get; } =
        new[] { "System.Windows.Controls.Grid", "System.Windows.Controls.Button" };

    static readonly string[] Assemblies =
    {
        "PresentationFramework.dll",
        "PresentationCore.dll",
        "WindowsBase.dll",
        "System.Xaml.dll",
    };

    public IEnumerable<string> ResolveFrameworkAssemblies(Tier1ReferenceEnvironment environment)
    {
        // On cross-platform machines MSBuild downloads Microsoft.WindowsDesktop.App.Ref into the
        // NuGet cache even with EnableWindowsTargeting=true, because the SDK packs/ folder never
        // ships it on non-Windows hosts; so the cache is tried first.
        var desktopDir = environment.FindNuGetRefDir("microsoft.windowsdesktop.app.ref")
                         ?? environment.FindPackRefDir("Microsoft.WindowsDesktop.App.Ref")
                         ?? environment.FindSharedRuntimeDir("Microsoft.WindowsDesktop.App");
        if (desktopDir is null)
        {
            Console.Error.WriteLine(
                "[WPF-LS] WARNING: Microsoft.WindowsDesktop.App references not found " +
                "in NuGet cache, packs/, or shared runtime.");
            return Array.Empty<string>();
        }

        Console.Error.WriteLine($"[WPF-LS] WPF reference dir: {desktopDir}");
        return Assemblies.Select(name => Path.Combine(desktopDir, name));
    }
}

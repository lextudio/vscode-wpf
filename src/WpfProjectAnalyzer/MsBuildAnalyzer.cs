using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using Microsoft.Build.Evaluation;
using Microsoft.Build.Locator;

namespace WpfProjectAnalyzer;

/// <summary>
/// Analyzes a project file using MSBuild evaluation.
/// Isolated in its own class so that the <c>Microsoft.Build</c> types are
/// not loaded until this class is first accessed — allowing the caller to
/// catch <see cref="TypeLoadException"/> / <see cref="FileNotFoundException"/>
/// and fall back to XML-only analysis.
/// </summary>
internal static class MsBuildAnalyzer
{
    private static bool _locatorRegistered;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static ProjectAnalysisResult Analyze(string projectPath)
    {
        EnsureLocatorRegistered();

        // Use a fresh ProjectCollection so we don't leak state across calls.
        using var collection = new ProjectCollection();

        // Set global properties that help SDK-style evaluation on non-Windows.
        var globalProps = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // EnableWindowsTargeting=true so the evaluation can resolve -windows TFMs
        // even on Linux/macOS. This does NOT change the user's project — it only
        // affects our evaluation pass.
        if (!OperatingSystem.IsWindows())
        {
            globalProps["EnableWindowsTargeting"] = "true";
        }

        Project msbuildProject;
        try
        {
            msbuildProject = collection.LoadProject(projectPath, globalProps, toolsVersion: null);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[WPF-PA] MSBuild LoadProject failed: {ex.Message}");
            throw;
        }

        var isSdkStyle = msbuildProject.Xml.Sdk is not null &&
                         msbuildProject.Xml.Sdk.Length > 0;

        var targetFramework = GetProperty(msbuildProject, "TargetFramework");
        var targetFrameworks = GetProperty(msbuildProject, "TargetFrameworks");
        var targetFrameworkVersion = GetProperty(msbuildProject, "TargetFrameworkVersion");
        var useWpf = GetBoolProperty(msbuildProject, "UseWPF");
        var useWinForms = GetBoolProperty(msbuildProject, "UseWindowsForms");
        var outputType = GetProperty(msbuildProject, "OutputType");

        // Read the user's actual EnableWindowsTargeting value (not our injected one).
        // We need to check the raw XML for this since we injected it as a global property.
        var enableWindowsTargeting = HasPropertyInProjectOrImports(msbuildProject, "EnableWindowsTargeting");

        var tfmList = ParseTfmList(targetFramework, targetFrameworks);
        var isLegacy = !isSdkStyle && !string.IsNullOrEmpty(targetFrameworkVersion);
        var hasWindowsTfm = tfmList.Any(static tfm =>
            tfm.Contains("-windows", StringComparison.OrdinalIgnoreCase));

        // Legacy WPF detection: check references
        var isWpfLegacy = false;
        if (isLegacy)
        {
            isWpfLegacy = msbuildProject.GetItems("Reference")
                .Any(static item =>
                    string.Equals(item.EvaluatedInclude, "PresentationFramework", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(item.EvaluatedInclude, "PresentationCore", StringComparison.OrdinalIgnoreCase));
        }

        var result = new ProjectAnalysisResult
        {
            ProjectPath = projectPath,
            IsSdkStyle = isSdkStyle,
            TargetFramework = targetFramework,
            TargetFrameworks = tfmList.Count > 0 ? tfmList : null,
            IsWindowsTfm = hasWindowsTfm || isLegacy,
            UseWPF = useWpf,
            UseWindowsForms = useWinForms,
            EnableWindowsTargeting = enableWindowsTargeting,
            IsLegacyFramework = isLegacy,
            TargetFrameworkVersion = targetFrameworkVersion,
            OutputType = outputType,
            IsWpfProject = useWpf || isWpfLegacy,
            MsBuildAvailable = true,
        };

        Program.ComputeSuggestions(result);
        return result;
    }

    /// <summary>
    /// Registers the MSBuild locator if it has not been registered yet.
    /// Must be called before any <c>Microsoft.Build</c> types are JIT-loaded.
    /// Returns <c>true</c> if the locator is ready (regardless of whether
    /// registration happened in this call or a prior one).
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static bool TryRegisterLocator()
    {
        try
        {
            EnsureLocatorRegistered();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void EnsureLocatorRegistered()
    {
        if (_locatorRegistered)
        {
            return;
        }

        // On .NET (Core) hosts, MSBuild can often discover SDK toolsets
        // automatically. Try MSBuildLocator first for explicit control.
        try
        {
            if (!MSBuildLocator.IsRegistered)
            {
                var instances = MSBuildLocator.QueryVisualStudioInstances().ToArray();
                if (instances.Length > 0)
                {
                    var latest = instances
                        .OrderByDescending(static i => i.Version)
                        .First();
                    MSBuildLocator.RegisterInstance(latest);
                    Console.Error.WriteLine($"[WPF-PA] MSBuild SDK: {latest.MSBuildPath}");
                }
                else
                {
                    MSBuildLocator.RegisterDefaults();
                    Console.Error.WriteLine("[WPF-PA] MSBuild SDK: defaults");
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[WPF-PA] MSBuildLocator failed: {ex.Message}");
            // Proceed anyway — MSBuild may still work via SDK discovery.
        }

        _locatorRegistered = true;
    }

    private static string? GetProperty(Project project, string name)
    {
        var value = project.GetPropertyValue(name);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static bool GetBoolProperty(Project project, string name)
    {
        return string.Equals(project.GetPropertyValue(name), "true", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Checks whether a property is explicitly set in the project file or any
    /// of its imports (Directory.Build.props, etc.) — not just injected via
    /// global properties.
    /// </summary>
    private static bool HasPropertyInProjectOrImports(Project project, string propertyName)
    {
        var prop = project.GetProperty(propertyName);
        if (prop is null || prop.IsGlobalProperty || prop.IsEnvironmentProperty || prop.IsReservedProperty)
        {
            return false;
        }

        // The property exists and was set by the project or an import.
        return string.Equals(prop.EvaluatedValue, "true", StringComparison.OrdinalIgnoreCase);
    }

    private static List<string> ParseTfmList(string? targetFramework, string? targetFrameworks)
    {
        var list = new List<string>();
        if (!string.IsNullOrWhiteSpace(targetFrameworks))
        {
            list.AddRange(targetFrameworks!.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        }
        else if (!string.IsNullOrWhiteSpace(targetFramework))
        {
            list.Add(targetFramework!.Trim());
        }

        return list;
    }
}

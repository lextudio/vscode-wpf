using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Linq;

namespace WpfProjectAnalyzer;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static int Main(string[] args)
    {
        if (args.Length < 1 || string.IsNullOrWhiteSpace(args[0]))
        {
            Console.Error.WriteLine("Usage: wpf-project-analyzer [--apply-enable-windows-targeting] <path-to-project-file>");
            return 3;
        }

        // Support an apply-mode to let the CLI modify a project file safely
        // from other tools (e.g. the VS Code extension) rather than having
        // the client manipulate XML itself.
        if (string.Equals(args[0], "--apply-enable-windows-targeting", StringComparison.OrdinalIgnoreCase))
        {
            if (args.Length < 2 || string.IsNullOrWhiteSpace(args[1]))
            {
                Console.Error.WriteLine("Usage: wpf-project-analyzer --apply-enable-windows-targeting <path-to-project-file>");
                return 3;
            }

            var projectPath = Path.GetFullPath(args[1]);
            if (!File.Exists(projectPath))
            {
                Console.Error.WriteLine($"Project file not found: {projectPath}");
                return 1;
            }

            try
            {
                var applied = ApplyEnableWindowsTargeting(projectPath, out var message);
                if (applied)
                {
                    var res = new { projectPath, applied = true, message };
                    Console.WriteLine(JsonSerializer.Serialize(res, JsonOptions));
                    return 0;
                }
                else
                {
                    Console.Error.WriteLine(message);
                    return 0; // not an error if already present
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Failed to apply change: {ex.Message}");
                return 2;
            }
        }

        var projectPathArg = Path.GetFullPath(args[0]);
        if (!File.Exists(projectPathArg))
        {
            WriteError("project_not_found", $"Project file not found: {projectPathArg}");
            return 1;
        }

        ProjectAnalysisResult result;

        // Fast XML pre-check: if this is clearly NOT a WPF project (Uno, Avalonia, WinUI, etc.),
        // short-circuit and return a non-WPF result without expensive MSBuild evaluation.
        if (IsNotWpfProject(projectPathArg))
        {
            try
            {
                result = AnalyzeWithXml(projectPathArg);
                result.MsBuildAvailable = false;
                Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WPF-PA] XML analysis failed: {ex.Message}");
                return 2;
            }
        }

        // Register the MSBuild locator BEFORE any Microsoft.Build types are
        // loaded by the JIT.  MsBuildAnalyzer is in a separate class with
        // [MethodImpl(NoInlining)] so its types are not touched until the
        // locator has had a chance to wire up assembly resolution.
        var msbuildReady = MsBuildAnalyzer.TryRegisterLocator();

        if (msbuildReady)
        {
            try
            {
                result = MsBuildAnalyzer.Analyze(projectPathArg);
                Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WPF-PA] MSBuild evaluation failed: {ex.Message}");
                Console.Error.WriteLine("[WPF-PA] Falling back to XML parsing.");
            }
        }

        try
        {
            result = AnalyzeWithXml(projectPathArg);
            result.MsBuildAvailable = false;
        }
        catch (Exception xmlEx)
        {
            WriteError("analysis_failed", $"XML analysis failed: {xmlEx.Message}");
            return 2;
        }

        Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions));
        return 0;
    }

    private static bool ApplyEnableWindowsTargeting(string projectPath, out string message)
    {
        return MsBuildAnalyzer.ApplyEnableWindowsTargeting(projectPath, out message);
    }

    // -------------------------------------------------------------------------
    // Fast XML pre-check: determine if a project is clearly NOT a WPF project
    // -------------------------------------------------------------------------

    /// <summary>
    /// Performs a fast XML pre-check to detect if a project is clearly NOT a WPF project.
    /// Returns true if the project has PackageReferences for Uno, Avalonia, WinUI, etc.
    /// This avoids expensive MSBuild evaluation for non-WPF projects.
    /// </summary>
    private static bool IsNotWpfProject(string projectPath)
    {
        try
        {
            var xml = File.ReadAllText(projectPath);

            // Check for non-WPF frameworks (these are explicit opt-ins, so if present, NOT WPF)
            if (xml.Contains("PackageReference", StringComparison.OrdinalIgnoreCase) &&
                (xml.Contains("Uno.WinUI", StringComparison.OrdinalIgnoreCase) ||
                 xml.Contains("Uno.UI", StringComparison.OrdinalIgnoreCase) ||
                 xml.Contains("Avalonia", StringComparison.OrdinalIgnoreCase) ||
                 xml.Contains("Microsoft.WindowsAppSDK", StringComparison.OrdinalIgnoreCase)))
            {
                return true; // Has non-WPF package references
            }

            // Check for UWP targeting
            if (xml.Contains("TargetPlatformIdentifier", StringComparison.OrdinalIgnoreCase) &&
                xml.Contains("UAP", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return false;
        }
        catch
        {
            // If we cannot read/parse, assume it might be WPF and let full analysis handle it
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // MSBuild-based analysis (preferred — resolves imports, conditionals, etc.)
    // -------------------------------------------------------------------------

    private static ProjectAnalysisResult AnalyzeWithMsBuild(string projectPath)
    {
        // MSBuild evaluation requires SDK discovery. On .NET (Core) hosts the
        // SDK is found automatically without MSBuildLocator in most cases.
        // We attempt evaluation directly; if it fails the caller falls back
        // to the XML path.
        return MsBuildAnalyzer.Analyze(projectPath);
    }

    // -------------------------------------------------------------------------
    // XML fallback (for when MSBuild SDK is unavailable — e.g. legacy projects
    // on non-Windows, or no .NET SDK installed)
    // -------------------------------------------------------------------------

    internal static ProjectAnalysisResult AnalyzeWithXml(string projectPath)
    {
        var doc = XDocument.Load(projectPath);
        var root = doc.Root!;
        var ns = root.GetDefaultNamespace();

        var isSdkStyle = root.Attribute("Sdk") is not null;

        // Collect all PropertyGroup children, handling namespaced and non-namespaced elements.
        var properties = root.Descendants()
            .Where(e => e.Parent is not null &&
                        string.Equals(e.Parent.Name.LocalName, "PropertyGroup", StringComparison.OrdinalIgnoreCase))
            .ToList();

        string? GetProperty(string name) =>
            properties.FirstOrDefault(e =>
                string.Equals(e.Name.LocalName, name, StringComparison.OrdinalIgnoreCase))?.Value?.Trim();

        var targetFramework = GetProperty("TargetFramework");
        var targetFrameworks = GetProperty("TargetFrameworks");
        var targetFrameworkVersion = GetProperty("TargetFrameworkVersion");
        var useWpf = GetProperty("UseWPF");
        var useWinForms = GetProperty("UseWindowsForms");
        var enableWindowsTargeting = GetProperty("EnableWindowsTargeting");
        var outputType = GetProperty("OutputType");

        var tfmList = ParseTfmList(targetFramework, targetFrameworks);
        var isLegacy = !isSdkStyle && !string.IsNullOrEmpty(targetFrameworkVersion);
        var hasWindowsTfm = tfmList.Any(IsWindowsTfm);

        // Legacy projects: check for WPF references or project type GUIDs
        var isWpfLegacy = false;
        if (isLegacy)
        {
            isWpfLegacy = HasWpfReferences(root, ns) || HasWpfProjectTypeGuid(root, ns);
        }

        var useWpfBool = ParseBool(useWpf);
        var useWinFormsBool = ParseBool(useWinForms);
        var enableWindowsTargetingBool = ParseBool(enableWindowsTargeting);
        var isWpfProject = useWpfBool || isWpfLegacy;

        var result = new ProjectAnalysisResult
        {
            ProjectPath = projectPath,
            IsSdkStyle = isSdkStyle,
            TargetFramework = targetFramework,
            TargetFrameworks = tfmList.Count > 0 ? tfmList : null,
            IsWindowsTfm = hasWindowsTfm || isLegacy,
            UseWPF = useWpfBool,
            UseWindowsForms = useWinFormsBool,
            EnableWindowsTargeting = enableWindowsTargetingBool,
            IsLegacyFramework = isLegacy,
            TargetFrameworkVersion = targetFrameworkVersion,
            OutputType = outputType,
            IsWpfProject = isWpfProject,
            MsBuildAvailable = false,
        };

        ComputeSuggestions(result);
        return result;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

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

    private static bool IsWindowsTfm(string tfm)
    {
        return tfm.Contains("-windows", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ParseBool(string? value)
    {
        return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
    }

    private static bool HasWpfReferences(XElement root, XNamespace ns)
    {
        // Look for <Reference Include="PresentationFramework" /> or similar
        var references = root.Descendants()
            .Where(e => string.Equals(e.Name.LocalName, "Reference", StringComparison.OrdinalIgnoreCase));

        return references.Any(r =>
        {
            var include = r.Attribute("Include")?.Value;
            return string.Equals(include, "PresentationFramework", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(include, "PresentationCore", StringComparison.OrdinalIgnoreCase);
        });
    }

    private static bool HasWpfProjectTypeGuid(XElement root, XNamespace ns)
    {
        // WPF project type GUID: {60DC8134-EBA5-43B8-BCC9-BB4BC16C2548}
        var guids = root.Descendants()
            .FirstOrDefault(e => string.Equals(e.Name.LocalName, "ProjectTypeGuids", StringComparison.OrdinalIgnoreCase));
        return guids?.Value?.Contains("60DC8134", StringComparison.OrdinalIgnoreCase) == true;
    }

    internal static void ComputeSuggestions(ProjectAnalysisResult result)
    {
        var suggestions = new List<string>();

        if (result.IsLegacyFramework)
        {
            if (result.IsWpfProject && !OperatingSystem.IsWindows())
            {
                // Legacy .NET Framework WPF projects cannot be built or analysed on
                // macOS/Linux: Mono's MSBuild ships Roslyn 3.x (no IIncrementalGenerator)
                // and has no WPF XAML codegen (PresentationBuildTasks).
                result.WindowsTargetingStatus = "legacy_wpf";
                suggestions.Add(
                    "Legacy .NET Framework WPF projects are not supported on macOS/Linux. " +
                    "Migrate to an SDK-style project with <UseWPF>true</UseWPF> to enable cross-platform tooling.");
            }
            else
            {
                // Legacy .NET Framework projects on Windows — no action needed.
                result.WindowsTargetingStatus = "native";
            }
        }
        else if (result.IsSdkStyle)
        {
            if (result.IsWindowsTfm && (result.UseWPF || result.IsWpfProject))
            {
                if (result.EnableWindowsTargeting)
                {
                    result.WindowsTargetingStatus = "enabled";
                }
                else if (!OperatingSystem.IsWindows())
                {
                    result.WindowsTargetingStatus = "required";
                    suggestions.Add(
                        "Add <EnableWindowsTargeting>true</EnableWindowsTargeting> to a <PropertyGroup> " +
                        "in your project file or Directory.Build.props to enable cross-platform WPF development.");
                }
                else
                {
                    // On Windows, EnableWindowsTargeting is not needed
                    result.WindowsTargetingStatus = "not_needed";
                }
            }
            else if (!result.IsWindowsTfm && result.UseWPF)
            {
                result.WindowsTargetingStatus = "missing_tfm";
                suggestions.Add(
                    "Your project sets <UseWPF>true</UseWPF> but the TargetFramework does not include " +
                    "the -windows suffix. Consider changing to e.g. net10.0-windows.");
            }
            else
            {
                result.WindowsTargetingStatus = "not_wpf";
            }
        }

        result.Suggestions = suggestions.Count > 0 ? suggestions : null;
    }

    private static void WriteError(string code, string message)
    {
        var error = new { error = code, message };
        Console.WriteLine(JsonSerializer.Serialize(error, JsonOptions));
    }
}

// -------------------------------------------------------------------------
// Result model
// -------------------------------------------------------------------------

internal sealed class ProjectAnalysisResult
{
    public string ProjectPath { get; set; } = string.Empty;
    public bool IsSdkStyle { get; set; }
    public string? TargetFramework { get; set; }
    public List<string>? TargetFrameworks { get; set; }
    public bool IsWindowsTfm { get; set; }
    public bool UseWPF { get; set; }
    public bool UseWindowsForms { get; set; }
    public bool EnableWindowsTargeting { get; set; }
    public bool IsLegacyFramework { get; set; }
    public string? TargetFrameworkVersion { get; set; }
    public string? OutputType { get; set; }
    public bool IsWpfProject { get; set; }
    public bool MsBuildAvailable { get; set; } = true;

    /// <summary>
    /// One of: "enabled", "required", "not_needed", "missing_tfm", "native", "not_wpf"
    /// </summary>
    public string? WindowsTargetingStatus { get; set; }

    public List<string>? Suggestions { get; set; }
}

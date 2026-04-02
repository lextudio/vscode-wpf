using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using XamlToCSharpGenerator.Core.Abstractions;
using XamlToCSharpGenerator.Core.Models;

namespace XamlToCSharpGenerator.WPF.Binding;

/// <summary>
/// Phase 1 semantic binder for WPF XAML.
///
/// Resolves named element types via <c>System.Windows.Markup.XmlnsDefinitionAttribute</c>
/// present in PresentationFramework, PresentationCore, WindowsBase, and any user assemblies
/// that declare the attribute. Returns a <see cref="ResolvedViewModel"/> populated enough for
/// <see cref="WpfCodeEmitter"/> to generate:
/// <list type="bullet">
///   <item>Typed field declarations for all <c>x:Name</c> elements</item>
///   <item><c>InitializeComponent()</c> that calls <c>Application.LoadComponent</c></item>
/// </list>
///
/// Phase 2 (future): resolve full object graph — all element types, property assignments,
/// attached properties, event subscriptions — enabling pure-C# emission without BAML.
/// </summary>
public sealed class WpfSemanticBinder : IXamlSemanticBinder
{
    private const string WpfXmlnsDefinitionAttributeMetadataName =
        "System.Windows.Markup.XmlnsDefinitionAttribute";

    // Cache the XmlnsDefinition map per compilation to avoid repeated assembly scans.
    private static readonly ConditionalWeakTable<Compilation, XmlnsDefinitionCacheEntry> XmlnsCache = new();

    public (ResolvedViewModel? ViewModel, ImmutableArray<DiagnosticInfo> Diagnostics) Bind(
        XamlDocumentModel document,
        Compilation compilation,
        GeneratorOptions options,
        XamlTransformConfiguration transformConfiguration)
    {
        if (!document.IsValid || document.ClassFullName is null)
            return (null, ImmutableArray<DiagnosticInfo>.Empty);

        var xmlnsMap = GetOrBuildXmlnsDefinitionMap(compilation);
        var namedElements = ResolveNamedElements(document.NamedElements, xmlnsMap, compilation);
        var rootTypeName = ResolveTypeName(
            document.RootObject.XmlNamespace,
            document.RootObject.XmlTypeName,
            xmlnsMap,
            compilation) ?? "object";

        var rootNode = new ResolvedObjectNode(
            KeyExpression: null,
            Name: document.RootObject.Name,
            TypeName: rootTypeName,
            IsBindingObjectNode: false,
            FactoryExpression: null,
            FactoryValueRequirements: ResolvedValueRequirements.None,
            UseServiceProviderConstructor: false,
            UseTopDownInitialization: false,
            PropertyAssignments: ImmutableArray<ResolvedPropertyAssignment>.Empty,
            PropertyElementAssignments: ImmutableArray<ResolvedPropertyElementAssignment>.Empty,
            EventSubscriptions: ImmutableArray<ResolvedEventSubscription>.Empty,
            Children: ImmutableArray<ResolvedObjectNode>.Empty,
            ChildAttachmentMode: ResolvedChildAttachmentMode.None,
            ContentPropertyName: null,
            Line: document.RootObject.Line,
            Column: document.RootObject.Column);

        // WPF relative pack URI: /AssemblyName;component/SubFolder/File.xaml
        var buildUri = BuildPackUri(document, compilation);

        var viewModel = new ResolvedViewModel(
            Document: document,
            BuildUri: buildUri,
            ClassModifier: document.ClassModifier ?? "public",
            CreateSourceInfo: false,
            EnableHotReload: false,
            EnableHotDesign: false,
            PassExecutionTrace: ImmutableArray<string>.Empty,
            EmitNameScopeRegistration: false,
            EmitStaticResourceResolver: false,
            HasXBind: false,
            RootObject: rootNode,
            NamedElements: namedElements,
            Resources: ImmutableArray<ResolvedResourceDefinition>.Empty,
            Templates: ImmutableArray<ResolvedTemplateDefinition>.Empty,
            CompiledBindings: ImmutableArray<ResolvedCompiledBindingDefinition>.Empty,
            UnsafeAccessors: ImmutableArray<ResolvedUnsafeAccessorDefinition>.Empty,
            Styles: ImmutableArray<ResolvedStyleDefinition>.Empty,
            ControlThemes: ImmutableArray<ResolvedControlThemeDefinition>.Empty,
            Includes: ImmutableArray<ResolvedIncludeDefinition>.Empty,
            HotDesignArtifactKind: ResolvedHotDesignArtifactKind.View,
            HotDesignScopeHints: ImmutableArray<string>.Empty);

        return (viewModel, ImmutableArray<DiagnosticInfo>.Empty);
    }

    // -------------------------------------------------------------------------
    // Type resolution
    // -------------------------------------------------------------------------

    private static ImmutableArray<ResolvedNamedElement> ResolveNamedElements(
        ImmutableArray<XamlNamedElement> namedElements,
        XmlnsDefinitionCacheEntry xmlnsMap,
        Compilation compilation)
    {
        if (namedElements.IsEmpty)
            return ImmutableArray<ResolvedNamedElement>.Empty;

        var builder = ImmutableArray.CreateBuilder<ResolvedNamedElement>(namedElements.Length);
        foreach (var element in namedElements)
        {
            var typeName = ResolveTypeName(element.XmlNamespace, element.XmlTypeName, xmlnsMap, compilation)
                           ?? element.XmlTypeName;  // fallback to unqualified name

            builder.Add(new ResolvedNamedElement(
                Name: element.Name,
                TypeName: typeName,
                FieldModifier: element.FieldModifier ?? "internal",
                Line: element.Line,
                Column: element.Column));
        }
        return builder.ToImmutable();
    }

    private static string? ResolveTypeName(
        string xmlNamespace,
        string xmlTypeName,
        XmlnsDefinitionCacheEntry xmlnsMap,
        Compilation compilation)
    {
        // clr-namespace: URIs (e.g. xmlns:local="clr-namespace:MyApp")
        if (xmlNamespace.StartsWith("clr-namespace:", StringComparison.Ordinal))
        {
            var clrNs = ParseClrNamespace(xmlNamespace);
            if (clrNs is not null)
            {
                var sym = compilation.GetTypeByMetadataName($"{clrNs}.{xmlTypeName}");
                if (sym is not null)
                    return ToDisplayName(sym);
            }
            return null;
        }

        // Standard xmlns: resolve via XmlnsDefinitionAttribute map
        if (xmlnsMap.TryGetNamespaces(xmlNamespace, out var clrNamespaces))
        {
            foreach (var ns in clrNamespaces)
            {
                var sym = compilation.GetTypeByMetadataName($"{ns}.{xmlTypeName}");
                if (sym is not null)
                    return ToDisplayName(sym);
            }
        }

        return null;
    }

    private static string? ParseClrNamespace(string xmlNamespace)
    {
        // "clr-namespace:My.Namespace;assembly=MyAssembly" or "clr-namespace:My.Namespace"
        var ns = xmlNamespace.Substring("clr-namespace:".Length);
        var semiIdx = ns.IndexOf(';');
        return semiIdx >= 0 ? ns.Substring(0, semiIdx) : ns;
    }

    private static string ToDisplayName(INamedTypeSymbol symbol) =>
        symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)
              .Replace("global::", string.Empty);

    // -------------------------------------------------------------------------
    // Pack URI
    // -------------------------------------------------------------------------

    private static string BuildPackUri(XamlDocumentModel document, Compilation compilation)
    {
        var assemblyName = compilation.AssemblyName ?? "Application";
        var targetPath = document.TargetPath.Replace('\\', '/').TrimStart('/');
        return $"/{assemblyName};component/{targetPath}";
    }

    // -------------------------------------------------------------------------
    // XmlnsDefinition cache
    // -------------------------------------------------------------------------

    private static XmlnsDefinitionCacheEntry GetOrBuildXmlnsDefinitionMap(Compilation compilation) =>
        XmlnsCache.GetValue(compilation, static c => BuildXmlnsDefinitionMap(c));

    private static XmlnsDefinitionCacheEntry BuildXmlnsDefinitionMap(Compilation compilation)
    {
        var attrType = compilation.GetTypeByMetadataName(WpfXmlnsDefinitionAttributeMetadataName);
        if (attrType is null)
            return XmlnsDefinitionCacheEntry.Empty;

        var map = new Dictionary<string, List<string>>(StringComparer.Ordinal);

        foreach (var assembly in EnumerateAssemblies(compilation))
        {
            foreach (var attr in assembly.GetAttributes())
            {
                if (!SymbolEqualityComparer.Default.Equals(attr.AttributeClass, attrType))
                    continue;
                if (attr.ConstructorArguments.Length < 2)
                    continue;
                if (attr.ConstructorArguments[0].Value is not string xmlNamespace ||
                    attr.ConstructorArguments[1].Value is not string clrNamespace)
                    continue;

                if (!map.TryGetValue(xmlNamespace, out var list))
                    map[xmlNamespace] = list = new List<string>();
                list.Add(clrNamespace);
            }
        }

        return new XmlnsDefinitionCacheEntry(map);
    }

    private static IEnumerable<IAssemblySymbol> EnumerateAssemblies(Compilation compilation)
    {
        var visited = new HashSet<IAssemblySymbol>(SymbolEqualityComparer.Default);
        foreach (var referenced in compilation.SourceModule.ReferencedAssemblySymbols)
        {
            if (referenced is not null && visited.Add(referenced))
                yield return referenced;
        }
        if (visited.Add(compilation.Assembly))
            yield return compilation.Assembly;
    }

    // -------------------------------------------------------------------------
    // Cache entry
    // -------------------------------------------------------------------------

    private sealed class XmlnsDefinitionCacheEntry
    {
        public static XmlnsDefinitionCacheEntry Empty { get; } = new(new Dictionary<string, List<string>>());

        private readonly Dictionary<string, List<string>> _map;

        public XmlnsDefinitionCacheEntry(Dictionary<string, List<string>> map) => _map = map;

        public bool TryGetNamespaces(string xmlNamespace, out IReadOnlyList<string> namespaces)
        {
            if (_map.TryGetValue(xmlNamespace, out var list))
            {
                namespaces = list;
                return true;
            }
            namespaces = Array.Empty<string>();
            return false;
        }
    }
}

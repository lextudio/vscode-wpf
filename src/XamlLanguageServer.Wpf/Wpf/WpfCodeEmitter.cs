using XamlToCSharpGenerator.Core.Models.Resolved;
using XamlToCSharpGenerator.Framework.Abstractions;

namespace XamlLanguageServer.Wpf.Wpf;

/// <summary>
/// Code emitter for WPF XAML.
///
/// WPF code generation (InitializeComponent, BAML embedding) is handled by the
/// standard Microsoft.NET.Sdk.WindowsDesktop MSBuild targets — not by this extension.
/// The language server never invokes the emitter; this is a required stub.
///
/// Future: if XSG-for-WPF source generation is added (generating partial classes
/// the way AXSG does for Avalonia), the real emission logic lives here.
/// </summary>
internal sealed class WpfCodeEmitter : IXamlFrameworkEmitter
{
    public static WpfCodeEmitter Instance { get; } = new();
    private WpfCodeEmitter() { }

    public (string HintName, string Source) Emit(ResolvedViewModel viewModel) =>
        (string.Empty, string.Empty);
}

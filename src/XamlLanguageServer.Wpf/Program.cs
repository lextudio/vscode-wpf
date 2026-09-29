using XamlLanguageServer.Wpf.Diagnostics;
using XamlLanguageServer.Wpf.Workspace;
using XamlToCSharpGenerator.LanguageService.Framework.Wpf;
using XamlToCSharpGenerator.LanguageServer.Hosting;

// The WPF XAML language server: WPF only (LibreWPF and Microsoft WPF are one dialect). Every other
// framework has its own server; this one never serves another framework's XAML.
Environment.ExitCode = await XamlLanguageServerHost.RunAsync(
    args,
    WpfLanguageFrameworkProvider.Instance.Framework,
    WpfTier1ReferenceSet.Instance,
    full => new DiagnosticCompilationProvider(full));

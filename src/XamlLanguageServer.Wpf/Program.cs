using System;
using System.Threading;
using XamlLanguageServer.Wpf.Wpf;
using XamlToCSharpGenerator.LanguageService;
using XamlToCSharpGenerator.LanguageService.Workspace;
using XamlToCSharpGenerator.LanguageServer.Protocol;
using XamlToCSharpGenerator.LanguageServer.Server;

// Redirect trace output that might corrupt the LSP stdio stream.
Console.OutputEncoding = System.Text.Encoding.UTF8;

var workspaceRoot = ParseArg(args, "--workspace");
var options = new XamlLanguageServiceOptions(workspaceRoot);

using var engine = new XamlLanguageServiceEngine(
    new DeferredCompilationProvider(static () => new MsBuildCompilationProvider()),
    WpfFrameworkProfile.Instance);

using var server = new AxsgLanguageServer(
    new LspMessageReader(Console.OpenStandardInput()),
    new LspMessageWriter(Console.OpenStandardOutput()),
    engine,
    options);

var exitCode = await server.RunAsync(CancellationToken.None).ConfigureAwait(false);
Environment.ExitCode = exitCode;

static string? ParseArg(string[] args, string name)
{
    for (var i = 0; i < args.Length - 1; i++)
    {
        if (string.Equals(args[i], name, StringComparison.Ordinal))
            return args[i + 1];
    }
    return null;
}

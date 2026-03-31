using WpfHotReload.Runtime;

// DOTNET_STARTUP_HOOKS entry point.
// The .NET runtime calls Initialize() before the app's Main() runs.
// We start a background thread that waits for the WPF Application to exist,
// then launches the named-pipe listener for hot reload.
internal class StartupHook
{
    internal static void Initialize()
    {
        try
        {
            // Avoid touching WPF objects from startup-hook threads.
            // The agent itself is resilient when Application.Current is not ready yet.
            WpfHotReloadAgent.EnsurePipeListenerStarted();
        }
        catch
        {
            // Never crash the host app because of hot reload plumbing.
        }
    }
}

using System.Windows;
using WpfHotReload.Runtime;

// DOTNET_STARTUP_HOOKS entry point.
// The .NET runtime calls Initialize() before the app's Main() runs.
// We start a background thread that waits for the WPF Application to exist,
// then launches the named-pipe listener for hot reload.
internal class StartupHook
{
    internal static void Initialize()
    {
        var thread = new Thread(WaitForApplicationAndStartListener)
        {
            IsBackground = true,
            Name = "WpfHotReloadStartup",
        };
        thread.Start();
    }

    private static void WaitForApplicationAndStartListener()
    {
        // Poll until Application.Current is available (WPF app has started).
        // Typically takes a few hundred milliseconds after Main() begins.
        for (var i = 0; i < 300; i++) // up to ~30 seconds
        {
            Thread.Sleep(100);
            var app = Application.Current;
            if (app is not null)
            {
                WpfHotReloadAgent.EnsurePipeListenerStarted();
                return;
            }
        }
    }
}

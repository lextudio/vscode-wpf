#if NETFRAMEWORK

using System;

namespace WpfHotReload.Runtime;

/// <summary>
/// AppDomainManager entry point for .NET Framework.
/// .NET Framework uses APPDOMAIN_MANAGER_ASM and APPDOMAIN_MANAGER_TYPE environment variables
/// instead of DOTNET_STARTUP_HOOKS. This class is instantiated by the CLR on startup.
/// </summary>
public class FrameworkStartupHook : AppDomainManager
{
    public override void InitializeNewDomain(AppDomainSetup appDomainInfo)
    {
        base.InitializeNewDomain(appDomainInfo);

        try
        {
            // Start the hot reload pipe listener in a background thread.
            // This mirrors what StartupHook.Initialize() does for .NET Core.
            WpfHotReloadAgent.EnsurePipeListenerStarted();
        }
        catch
        {
            // Never crash the host app because of hot reload plumbing.
        }
    }
}

#endif

using XamlToCSharpGenerator.Core.Models;

using XamlLanguageServer.Wpf;

using Xunit;

namespace XamlLanguageServer.Wpf.Tests;

/// <summary>
/// The server can be told which XAML dialect to serve, which is what lets one binary serve any
/// framework registered in the built-in registry instead of only WPF. Naming a dialect this build
/// does not have must fail loudly: defaulting would serve one framework's XAML as another's and
/// produce confidently wrong completions.
/// </summary>
public sealed class FrameworkSelectionTests
{
    [Fact]
    public void No_Id_Keeps_The_Historical_Wpf_Default()
    {
        // The dll is still named wpf-xaml-ls and OpenDevelop still launches it with only
        // --workspace, so "no --framework" has to keep meaning WPF.
        Assert.Equal(FrameworkProfileIds.Wpf, FrameworkSelection.Resolve(null).Id);
        Assert.Equal(FrameworkProfileIds.Wpf, FrameworkSelection.Resolve("").Id);
        Assert.Equal(FrameworkProfileIds.Wpf, FrameworkSelection.Resolve("   ").Id);
        Assert.Equal(FrameworkSelection.Default.Id, FrameworkSelection.Resolve(null).Id);
    }

    [Theory]
    [InlineData(FrameworkProfileIds.Wpf)]
    [InlineData(FrameworkProfileIds.WinUI)]
    [InlineData(FrameworkProfileIds.Uno)]
    [InlineData(FrameworkProfileIds.Maui)]
    [InlineData(FrameworkProfileIds.Avalonia)]
    public void A_Registered_Framework_Id_Is_Accepted(string id)
    {
        // The point of the argument: a host that knows its project is MAUI can name MAUI and get
        // MAUI's profile rather than the WPF one this server used to hardcode. Ids come from
        // FrameworkProfileIds rather than literals because TryGetById matches exactly — "Maui" and
        // "MAUI" are different ids, and guessing the casing fails at runtime, not at compile time.
        Assert.Equal(id, FrameworkSelection.Resolve(id).Id);
    }

    [Fact]
    public void Resolving_By_Id_Returns_That_Frameworks_Own_Metadata()
    {
        var maui = FrameworkSelection.Resolve(FrameworkProfileIds.Maui);

        Assert.Equal("http://schemas.microsoft.com/dotnet/2021/maui", maui.DefaultXmlNamespace);
        Assert.Contains(
            "Microsoft.Maui.Controls.XmlnsDefinitionAttribute",
            maui.XmlnsDefinitionAttributeMetadataNames);
    }

    [Fact]
    public void The_Default_Framework_Presentation_Namespace_Is_Wpf()
    {
        Assert.Equal(
            "http://schemas.microsoft.com/winfx/2006/xaml/presentation",
            FrameworkSelection.Default.DefaultXmlNamespace);
    }

    [Theory]
    [InlineData("Avalonia11")]
    [InlineData("Wpf2")]
    [InlineData("nonsense")]
    public void An_Unknown_Id_Is_Rejected_Rather_Than_Defaulted(string id)
    {
        var error = Assert.Throws<InvalidOperationException>(() => FrameworkSelection.Resolve(id));

        Assert.Contains(id, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void The_Error_Lists_What_This_Build_Can_Actually_Serve()
    {
        var error = Assert.Throws<InvalidOperationException>(() => FrameworkSelection.Resolve("nope"));

        foreach (string id in new[]
                 {
                     FrameworkProfileIds.Wpf, FrameworkProfileIds.WinUI, FrameworkProfileIds.Uno,
                     FrameworkProfileIds.Maui, FrameworkProfileIds.Avalonia,
                 })
        {
            Assert.Contains(id, error.Message, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData("maui")]
    [InlineData("MAUI")]
    [InlineData("  MAUI  ")]
    public void Framework_Ids_Are_Matched_Case_Insensitively_And_Trimmed(string id)
    {
        // Not this type's decision: XamlLanguageFrameworkRegistry builds its lookup with
        // OrdinalIgnoreCase and trims the incoming id. Pinned because a launcher passing the wrong
        // casing must still reach the right framework, and because changing the registry's
        // comparer would silently change what this accepts.
        Assert.Equal(FrameworkProfileIds.Maui, FrameworkSelection.Resolve(id).Id);
    }

    [Fact]
    public void The_Argument_Name_Is_The_One_The_Host_Launcher_Passes()
    {
        Assert.Equal("--framework", FrameworkSelection.ArgumentName);
    }
}

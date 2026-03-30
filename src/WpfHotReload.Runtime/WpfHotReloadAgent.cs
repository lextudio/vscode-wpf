using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;

namespace WpfHotReload.Runtime;

public static class WpfHotReloadAgent
{
    public static string ApplyXamlTextFromBase64(string filePath, string base64Text)
    {
        try
        {
            var xamlText = Encoding.UTF8.GetString(Convert.FromBase64String(base64Text));
            var app = Application.Current;
            if (app is null)
            {
                return "error: no current WPF application";
            }

            return app.Dispatcher.Invoke(() => ApplyXamlTextCore(filePath, xamlText));
        }
        catch (Exception ex)
        {
            return $"error: {ex.GetType().Name}: {ex.Message}";
        }
    }

    private static string ApplyXamlTextCore(string filePath, string xamlText)
    {
        var xClass = TryExtractXClass(xamlText);
        var sanitizedXaml = StripCompileOnlyAttributes(xamlText);

        object parsedRoot;
        try
        {
            parsedRoot = XamlReader.Parse(sanitizedXaml);
        }
        catch (Exception ex)
        {
            return $"error: parse failed: {ex.Message}";
        }

        var liveRoot = FindLiveRoot(xClass, parsedRoot);
        if (liveRoot is null)
        {
            return $"error: no live root matched {xClass ?? filePath}";
        }

        return ApplyParsedRoot(liveRoot, parsedRoot);
    }

    private static object? FindLiveRoot(string? xClass, object parsedRoot)
    {
        if (Application.Current is null)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(xClass))
        {
            var exactWindow = Application.Current.Windows
                .OfType<Window>()
                .FirstOrDefault(w => string.Equals(w.GetType().FullName, xClass, StringComparison.Ordinal));
            if (exactWindow is not null)
            {
                return exactWindow;
            }
        }

        if (parsedRoot is Window)
        {
            return Application.Current.MainWindow
                ?? Application.Current.Windows.OfType<Window>().FirstOrDefault();
        }

        return Application.Current.MainWindow;
    }

    private static string ApplyParsedRoot(object liveRoot, object parsedRoot)
    {
        if (liveRoot is Window liveWindow && parsedRoot is Window parsedWindow)
        {
            ApplyWindow(liveWindow, parsedWindow);
            return "ok: window updated";
        }

        if (liveRoot is ContentControl liveContentControl && parsedRoot is ContentControl parsedContentControl)
        {
            ApplyContentControl(liveContentControl, parsedContentControl);
            return "ok: content control updated";
        }

        if (liveRoot is Panel livePanel && parsedRoot is Panel parsedPanel)
        {
            ApplyPanel(livePanel, parsedPanel);
            return "ok: panel updated";
        }

        return $"error: unsupported live root pair {liveRoot.GetType().FullName} <= {parsedRoot.GetType().FullName}";
    }

    private static void ApplyWindow(Window liveWindow, Window parsedWindow)
    {
        liveWindow.Title = parsedWindow.Title;
        liveWindow.Width = parsedWindow.Width;
        liveWindow.Height = parsedWindow.Height;
        liveWindow.MinWidth = parsedWindow.MinWidth;
        liveWindow.MinHeight = parsedWindow.MinHeight;
        liveWindow.MaxWidth = parsedWindow.MaxWidth;
        liveWindow.MaxHeight = parsedWindow.MaxHeight;
        liveWindow.SizeToContent = parsedWindow.SizeToContent;
        liveWindow.WindowStyle = parsedWindow.WindowStyle;
        liveWindow.ResizeMode = parsedWindow.ResizeMode;
        liveWindow.Background = parsedWindow.Background;
        liveWindow.Resources = parsedWindow.Resources;

        if (parsedWindow.Content is object content)
        {
            parsedWindow.Content = null;
            liveWindow.Content = content;
        }
    }

    private static void ApplyContentControl(ContentControl liveControl, ContentControl parsedControl)
    {
        liveControl.Resources = parsedControl.Resources;
        if (parsedControl.Content is object content)
        {
            parsedControl.Content = null;
            liveControl.Content = content;
        }
    }

    private static void ApplyPanel(Panel livePanel, Panel parsedPanel)
    {
        livePanel.Resources = parsedPanel.Resources;
        var children = parsedPanel.Children.Cast<UIElement>().ToList();
        parsedPanel.Children.Clear();
        livePanel.Children.Clear();
        foreach (var child in children)
        {
            livePanel.Children.Add(child);
        }
    }

    private static string? TryExtractXClass(string xamlText)
    {
        var match = Regex.Match(xamlText, @"\bx:Class\s*=\s*""([^""]+)""", RegexOptions.CultureInvariant);
        return match.Success ? match.Groups[1].Value : null;
    }

    private static string StripCompileOnlyAttributes(string xamlText)
    {
        var stripped = Regex.Replace(
            xamlText,
            @"\s+x:Class\s*=\s*""[^""]*""",
            string.Empty,
            RegexOptions.CultureInvariant);

        stripped = Regex.Replace(
            stripped,
            @"\s+x:Subclass\s*=\s*""[^""]*""",
            string.Empty,
            RegexOptions.CultureInvariant);

        return stripped;
    }
}

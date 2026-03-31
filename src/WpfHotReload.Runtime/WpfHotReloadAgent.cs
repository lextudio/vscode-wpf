using System.Collections;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Media3D;

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

        var liveRoot = FindLiveRoot(filePath, xClass, parsedRoot);
        if (liveRoot is null)
        {
            return $"error: no live root matched {xClass ?? filePath}";
        }

        return ApplyParsedRoot(liveRoot, parsedRoot);
    }

    private static object? FindLiveRoot(string filePath, string? xClass, object parsedRoot)
    {
        if (Application.Current is null)
        {
            return null;
        }

        var candidates = EnumerateLiveCandidates().ToList();

        if (!string.IsNullOrWhiteSpace(xClass))
        {
            var exactMatch = candidates.FirstOrDefault(candidate =>
                string.Equals(candidate.GetType().FullName, xClass, StringComparison.Ordinal));
            if (exactMatch is not null)
            {
                return exactMatch;
            }
        }

        if (parsedRoot is Window)
        {
            return Application.Current.MainWindow
                ?? Application.Current.Windows.OfType<Window>().FirstOrDefault();
        }

        var fileStem = Path.GetFileNameWithoutExtension(filePath);
        if (!string.IsNullOrWhiteSpace(fileStem))
        {
            var fileNameMatch = candidates.FirstOrDefault(candidate =>
                string.Equals(candidate.GetType().Name, fileStem, StringComparison.OrdinalIgnoreCase));
            if (fileNameMatch is not null)
            {
                return fileNameMatch;
            }
        }

        var parsedType = parsedRoot.GetType();
        var typeMatch = candidates.FirstOrDefault(candidate => candidate.GetType() == parsedType);
        if (typeMatch is not null)
        {
            return typeMatch;
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

        if (liveRoot is HeaderedContentControl liveHeaderedContentControl &&
            parsedRoot is HeaderedContentControl parsedHeaderedContentControl)
        {
            ApplyHeaderedContentControl(liveHeaderedContentControl, parsedHeaderedContentControl);
            return "ok: headered content control updated";
        }

        if (liveRoot is Panel livePanel && parsedRoot is Panel parsedPanel)
        {
            ApplyPanel(livePanel, parsedPanel);
            return "ok: panel updated";
        }

        if (liveRoot is Decorator liveDecorator && parsedRoot is Decorator parsedDecorator)
        {
            ApplyDecorator(liveDecorator, parsedDecorator);
            return "ok: decorator updated";
        }

        if (liveRoot is ItemsControl liveItemsControl && parsedRoot is ItemsControl parsedItemsControl)
        {
            ApplyItemsControl(liveItemsControl, parsedItemsControl);
            return "ok: items control updated";
        }

        if (liveRoot is ResourceDictionary liveDictionary && parsedRoot is ResourceDictionary parsedDictionary)
        {
            ApplyResourceDictionary(liveDictionary, parsedDictionary);
            return "ok: resource dictionary updated";
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

    private static void ApplyHeaderedContentControl(
        HeaderedContentControl liveControl,
        HeaderedContentControl parsedControl)
    {
        liveControl.Resources = parsedControl.Resources;
        liveControl.Header = parsedControl.Header;
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

    private static void ApplyDecorator(Decorator liveDecorator, Decorator parsedDecorator)
    {
        if (parsedDecorator.Child is UIElement child)
        {
            parsedDecorator.Child = null;
            liveDecorator.Child = child;
        }
    }

    private static void ApplyItemsControl(ItemsControl liveItemsControl, ItemsControl parsedItemsControl)
    {
        liveItemsControl.Resources = parsedItemsControl.Resources;
        if (parsedItemsControl.ItemsSource is not null)
        {
            liveItemsControl.ItemsSource = parsedItemsControl.ItemsSource;
            return;
        }

        var items = parsedItemsControl.Items.Cast<object>().ToList();
        parsedItemsControl.Items.Clear();
        liveItemsControl.Items.Clear();
        foreach (var item in items)
        {
            liveItemsControl.Items.Add(item);
        }
    }

    private static void ApplyResourceDictionary(ResourceDictionary liveDictionary, ResourceDictionary parsedDictionary)
    {
        liveDictionary.Clear();
        foreach (DictionaryEntry entry in parsedDictionary)
        {
            liveDictionary[entry.Key] = entry.Value;
        }

        liveDictionary.MergedDictionaries.Clear();
        foreach (var mergedDictionary in parsedDictionary.MergedDictionaries.ToList())
        {
            liveDictionary.MergedDictionaries.Add(mergedDictionary);
        }
    }

    private static IEnumerable<object> EnumerateLiveCandidates()
    {
        if (Application.Current is null)
        {
            yield break;
        }

        foreach (Window window in Application.Current.Windows)
        {
            yield return window;
            foreach (var descendant in EnumerateDescendants(window))
            {
                yield return descendant;
            }
        }

        yield return Application.Current.Resources;
    }

    private static IEnumerable<object> EnumerateDescendants(DependencyObject root)
    {
        var queue = new Queue<object>();
        queue.Enqueue(root);

        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            if (!ReferenceEquals(current, root))
            {
                yield return current;
            }

            if (current is DependencyObject dependencyObject)
            {
                var visualChildCount = 0;
                if (dependencyObject is Visual || dependencyObject is Visual3D)
                {
                    visualChildCount = VisualTreeHelper.GetChildrenCount(dependencyObject);
                }

                for (var i = 0; i < visualChildCount; i++)
                {
                    queue.Enqueue(VisualTreeHelper.GetChild(dependencyObject, i));
                }

                foreach (var logicalChild in LogicalTreeHelper.GetChildren(dependencyObject))
                {
                    queue.Enqueue(logicalChild);
                }
            }
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

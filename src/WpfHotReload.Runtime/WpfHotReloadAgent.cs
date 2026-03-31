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
        if (TryApplyObject(liveRoot, parsedRoot))
        {
            return $"ok: {DescribeApplyResult(liveRoot)}";
        }

        return $"error: unsupported live root pair {liveRoot.GetType().FullName} <= {parsedRoot.GetType().FullName}";
    }

    private static bool TryApplyObject(object liveObject, object parsedObject)
    {
        if (liveObject is ResourceDictionary liveDictionary && parsedObject is ResourceDictionary parsedDictionary)
        {
            ApplyResourceDictionary(liveDictionary, parsedDictionary);
            return true;
        }

        if (liveObject is Window liveWindow && parsedObject is Window parsedWindow)
        {
            ApplyWindow(liveWindow, parsedWindow);
            return true;
        }

        if (liveObject is HeaderedContentControl liveHeaderedContentControl &&
            parsedObject is HeaderedContentControl parsedHeaderedContentControl)
        {
            ApplyHeaderedContentControl(liveHeaderedContentControl, parsedHeaderedContentControl);
            return true;
        }

        if (liveObject is ContentControl liveContentControl && parsedObject is ContentControl parsedContentControl)
        {
            ApplyContentControl(liveContentControl, parsedContentControl);
            return true;
        }

        if (liveObject is Border liveBorder && parsedObject is Border parsedBorder)
        {
            ApplyBorder(liveBorder, parsedBorder);
            return true;
        }

        if (liveObject is Decorator liveDecorator && parsedObject is Decorator parsedDecorator)
        {
            ApplyDecorator(liveDecorator, parsedDecorator);
            return true;
        }

        if (liveObject is Panel livePanel && parsedObject is Panel parsedPanel)
        {
            ApplyPanel(livePanel, parsedPanel);
            return true;
        }

        if (liveObject is TextBlock liveTextBlock && parsedObject is TextBlock parsedTextBlock)
        {
            ApplyTextBlock(liveTextBlock, parsedTextBlock);
            return true;
        }

        if (liveObject is ItemsControl liveItemsControl && parsedObject is ItemsControl parsedItemsControl)
        {
            ApplyItemsControl(liveItemsControl, parsedItemsControl);
            return true;
        }

        return false;
    }

    private static string DescribeApplyResult(object liveRoot)
    {
        return liveRoot switch
        {
            Window => "window updated",
            HeaderedContentControl => "headered content control updated",
            ContentControl => "content control updated",
            Border => "border updated",
            Decorator => "decorator updated",
            Panel => "panel updated",
            TextBlock => "text block updated",
            ItemsControl => "items control updated",
            ResourceDictionary => "resource dictionary updated",
            _ => $"{liveRoot.GetType().Name} updated"
        };
    }

    private static void ApplyWindow(Window liveWindow, Window parsedWindow)
    {
        ApplyFrameworkElement(liveWindow, parsedWindow);
        ApplyControl(liveWindow, parsedWindow);
        liveWindow.Title = parsedWindow.Title;
        liveWindow.SizeToContent = parsedWindow.SizeToContent;
        liveWindow.WindowStyle = parsedWindow.WindowStyle;
        liveWindow.ResizeMode = parsedWindow.ResizeMode;
        ApplyContentValue(liveWindow, parsedWindow.Content, content => liveWindow.Content = content);
    }

    private static void ApplyContentControl(ContentControl liveControl, ContentControl parsedControl)
    {
        ApplyFrameworkElement(liveControl, parsedControl);
        ApplyControl(liveControl, parsedControl);
        ApplyContentValue(liveControl, parsedControl.Content, content => liveControl.Content = content);
    }

    private static void ApplyHeaderedContentControl(
        HeaderedContentControl liveControl,
        HeaderedContentControl parsedControl)
    {
        ApplyFrameworkElement(liveControl, parsedControl);
        ApplyControl(liveControl, parsedControl);
        liveControl.Header = parsedControl.Header;
        ApplyContentValue(liveControl, parsedControl.Content, content => liveControl.Content = content);
    }

    private static void ApplyPanel(Panel livePanel, Panel parsedPanel)
    {
        ApplyFrameworkElement(livePanel, parsedPanel);
        var parsedChildren = parsedPanel.Children.Cast<UIElement>().ToList();
        var liveChildren = livePanel.Children.Cast<UIElement>().ToList();
        if (!TryApplyPanelChildrenInPlace(livePanel, parsedPanel, liveChildren, parsedChildren))
        {
            ReplacePanelChildren(livePanel, parsedPanel, parsedChildren);
        }
    }

    private static void ApplyDecorator(Decorator liveDecorator, Decorator parsedDecorator)
    {
        ApplyFrameworkElement(liveDecorator, parsedDecorator);
        if (liveDecorator.Child is UIElement liveChild &&
            parsedDecorator.Child is UIElement parsedChild &&
            CanApplyChildInPlace(liveChild, parsedChild) &&
            TryApplyObject(liveChild, parsedChild))
        {
            return;
        }

        if (parsedDecorator.Child is UIElement child)
        {
            parsedDecorator.Child = null;
            liveDecorator.Child = child;
        }
    }

    private static void ApplyBorder(Border liveBorder, Border parsedBorder)
    {
        ApplyFrameworkElement(liveBorder, parsedBorder);
        liveBorder.Background = parsedBorder.Background;
        liveBorder.BorderBrush = parsedBorder.BorderBrush;
        liveBorder.BorderThickness = parsedBorder.BorderThickness;
        liveBorder.Padding = parsedBorder.Padding;
        liveBorder.CornerRadius = parsedBorder.CornerRadius;
        liveBorder.SnapsToDevicePixels = parsedBorder.SnapsToDevicePixels;

        if (liveBorder.Child is UIElement liveChild &&
            parsedBorder.Child is UIElement parsedChild &&
            CanApplyChildInPlace(liveChild, parsedChild) &&
            TryApplyObject(liveChild, parsedChild))
        {
            return;
        }

        if (parsedBorder.Child is UIElement child)
        {
            parsedBorder.Child = null;
            liveBorder.Child = child;
        }
    }

    private static void ApplyItemsControl(ItemsControl liveItemsControl, ItemsControl parsedItemsControl)
    {
        ApplyFrameworkElement(liveItemsControl, parsedItemsControl);
        ApplyControl(liveItemsControl, parsedItemsControl);
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

    private static void ApplyTextBlock(TextBlock liveTextBlock, TextBlock parsedTextBlock)
    {
        ApplyFrameworkElement(liveTextBlock, parsedTextBlock);
        liveTextBlock.Background = parsedTextBlock.Background;
        liveTextBlock.Foreground = parsedTextBlock.Foreground;
        liveTextBlock.FontFamily = parsedTextBlock.FontFamily;
        liveTextBlock.FontSize = parsedTextBlock.FontSize;
        liveTextBlock.FontStretch = parsedTextBlock.FontStretch;
        liveTextBlock.FontStyle = parsedTextBlock.FontStyle;
        liveTextBlock.FontWeight = parsedTextBlock.FontWeight;
        liveTextBlock.Padding = parsedTextBlock.Padding;
        liveTextBlock.TextAlignment = parsedTextBlock.TextAlignment;
        liveTextBlock.TextWrapping = parsedTextBlock.TextWrapping;
        liveTextBlock.TextTrimming = parsedTextBlock.TextTrimming;
        liveTextBlock.LineHeight = parsedTextBlock.LineHeight;
        liveTextBlock.Text = parsedTextBlock.Text;
        liveTextBlock.Inlines.Clear();
        foreach (var inline in parsedTextBlock.Inlines.ToList())
        {
            parsedTextBlock.Inlines.Remove(inline);
            liveTextBlock.Inlines.Add(inline);
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

    private static void ApplyFrameworkElement(FrameworkElement liveElement, FrameworkElement parsedElement)
    {
        liveElement.Width = parsedElement.Width;
        liveElement.Height = parsedElement.Height;
        liveElement.MinWidth = parsedElement.MinWidth;
        liveElement.MinHeight = parsedElement.MinHeight;
        liveElement.MaxWidth = parsedElement.MaxWidth;
        liveElement.MaxHeight = parsedElement.MaxHeight;
        liveElement.Margin = parsedElement.Margin;
        liveElement.HorizontalAlignment = parsedElement.HorizontalAlignment;
        liveElement.VerticalAlignment = parsedElement.VerticalAlignment;
        liveElement.FlowDirection = parsedElement.FlowDirection;
        liveElement.Style = parsedElement.Style;
        liveElement.Resources = parsedElement.Resources;
        liveElement.ToolTip = parsedElement.ToolTip;
        liveElement.Tag = parsedElement.Tag;
        liveElement.Visibility = parsedElement.Visibility;
        liveElement.DataContext = parsedElement.DataContext;
    }

    private static void ApplyControl(Control liveControl, Control parsedControl)
    {
        liveControl.Background = parsedControl.Background;
        liveControl.BorderBrush = parsedControl.BorderBrush;
        liveControl.BorderThickness = parsedControl.BorderThickness;
        liveControl.Padding = parsedControl.Padding;
        liveControl.FontFamily = parsedControl.FontFamily;
        liveControl.FontSize = parsedControl.FontSize;
        liveControl.FontStretch = parsedControl.FontStretch;
        liveControl.FontStyle = parsedControl.FontStyle;
        liveControl.FontWeight = parsedControl.FontWeight;
        liveControl.Foreground = parsedControl.Foreground;
        liveControl.HorizontalContentAlignment = parsedControl.HorizontalContentAlignment;
        liveControl.VerticalContentAlignment = parsedControl.VerticalContentAlignment;
        liveControl.IsEnabled = parsedControl.IsEnabled;
    }

    private static void ApplyContentValue(DependencyObject liveOwner, object? parsedContent, Action<object?> assignContent)
    {
        if (liveOwner is ContentControl liveContentControl &&
            liveContentControl.Content is object liveContent &&
            parsedContent is object parsedContentObject &&
            CanApplyContentInPlace(liveContent, parsedContentObject) &&
            TryApplyObject(liveContent, parsedContentObject))
        {
            return;
        }

        if (parsedContent is DependencyObject parsedDependencyObject)
        {
            DetachFromParent(parsedDependencyObject);
        }

        assignContent(parsedContent);
    }

    private static bool CanApplyContentInPlace(object liveContent, object parsedContent)
    {
        if (liveContent.GetType() != parsedContent.GetType())
        {
            return false;
        }

        return NameMatches(liveContent, parsedContent);
    }

    private static bool TryApplyPanelChildrenInPlace(
        Panel livePanel,
        Panel parsedPanel,
        IReadOnlyList<UIElement> liveChildren,
        IReadOnlyList<UIElement> parsedChildren)
    {
        var liveNamedChildren = liveChildren
            .Select((child, index) => new { child, index, name = GetElementName(child) })
            .Where(entry => string.IsNullOrWhiteSpace(entry.name) is false)
            .GroupBy(entry => entry.name!, StringComparer.Ordinal)
            .Where(group => group.Count() == 1)
            .ToDictionary(group => group.Key, group => (group.Single().child, group.Single().index), StringComparer.Ordinal);

        var usedLiveIndexes = new HashSet<int>();
        var reorderedChildren = new List<UIElement>(parsedChildren.Count);
        var nextPositionalLiveIndex = 0;

        foreach (var parsedChild in parsedChildren)
        {
            var matchingLiveChild = FindMatchingLiveChild(
                parsedChild,
                liveChildren,
                liveNamedChildren,
                usedLiveIndexes,
                ref nextPositionalLiveIndex);

            if (matchingLiveChild is not null)
            {
                if (!TryApplyObject(matchingLiveChild, parsedChild))
                {
                    return false;
                }

                reorderedChildren.Add(matchingLiveChild);
                continue;
            }

            reorderedChildren.Add(parsedChild);
        }

        parsedPanel.Children.Clear();
        livePanel.Children.Clear();
        foreach (var child in reorderedChildren)
        {
            livePanel.Children.Add(child);
        }

        return true;
    }

    private static bool CanApplyChildInPlace(object liveChild, object parsedChild)
    {
        return liveChild.GetType() == parsedChild.GetType() && NameMatches(liveChild, parsedChild);
    }

    private static bool NameMatches(object liveObject, object parsedObject)
    {
        var liveName = GetElementName(liveObject);
        var parsedName = GetElementName(parsedObject);
        if (string.IsNullOrWhiteSpace(liveName) && string.IsNullOrWhiteSpace(parsedName))
        {
            return true;
        }

        return string.Equals(liveName, parsedName, StringComparison.Ordinal);
    }

    private static string? GetElementName(object value)
    {
        return value switch
        {
            FrameworkElement frameworkElement => frameworkElement.Name,
            FrameworkContentElement frameworkContentElement => frameworkContentElement.Name,
            _ => null
        };
    }

    private static void ReplacePanelChildren(Panel livePanel, Panel parsedPanel, List<UIElement> parsedChildren)
    {
        parsedPanel.Children.Clear();
        livePanel.Children.Clear();
        foreach (var child in parsedChildren)
        {
            livePanel.Children.Add(child);
        }
    }

    private static UIElement? FindMatchingLiveChild(
        UIElement parsedChild,
        IReadOnlyList<UIElement> liveChildren,
        IReadOnlyDictionary<string, (UIElement child, int index)> liveNamedChildren,
        ISet<int> usedLiveIndexes,
        ref int nextPositionalLiveIndex)
    {
        var parsedName = GetElementName(parsedChild);
        if (!string.IsNullOrWhiteSpace(parsedName) &&
            liveNamedChildren.TryGetValue(parsedName, out var namedMatch) &&
            !usedLiveIndexes.Contains(namedMatch.index) &&
            namedMatch.child.GetType() == parsedChild.GetType())
        {
            usedLiveIndexes.Add(namedMatch.index);
            return namedMatch.child;
        }

        while (nextPositionalLiveIndex < liveChildren.Count)
        {
            var liveIndex = nextPositionalLiveIndex++;
            if (usedLiveIndexes.Contains(liveIndex))
            {
                continue;
            }

            var liveChild = liveChildren[liveIndex];
            if (!CanApplyChildInPlace(liveChild, parsedChild))
            {
                continue;
            }

            usedLiveIndexes.Add(liveIndex);
            return liveChild;
        }

        return null;
    }

    private static void DetachFromParent(DependencyObject dependencyObject)
    {
        switch (dependencyObject)
        {
            case UIElement element when VisualTreeHelper.GetParent(element) is Panel panel:
                panel.Children.Remove(element);
                break;
            case FrameworkElement frameworkElement when frameworkElement.Parent is ContentControl contentControl:
                if (ReferenceEquals(contentControl.Content, frameworkElement))
                {
                    contentControl.Content = null;
                }
                break;
            case FrameworkElement frameworkElement when frameworkElement.Parent is Decorator decorator:
                if (ReferenceEquals(decorator.Child, frameworkElement))
                {
                    decorator.Child = null;
                }
                break;
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

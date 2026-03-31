using System.Collections;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Media3D;

namespace WpfHotReload.Runtime;

public static class WpfHotReloadAgent
{
    private static volatile bool _pipeListenerRunning;
    private static CancellationTokenSource? _pipeCts;

    public static string PipeName { get; } =
        Environment.GetEnvironmentVariable("WPF_HOTRELOAD_PIPE")
        ?? $"wpf-hotreload-{Environment.ProcessId}";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static void Log(string message)
    {
        Debug.WriteLine($"[WpfHotReload] {message}");
    }

    /// <summary>
    /// Called by StartupHook once Application.Current is available.
    /// Safe to call multiple times — only the first call starts the listener.
    /// </summary>
    public static void EnsurePipeListenerStarted()
    {
        Log($"EnsurePipeListenerStarted called, already running={_pipeListenerRunning}");
        if (_pipeListenerRunning)
        {
            return;
        }

        _pipeCts?.Cancel();
        _pipeCts = new CancellationTokenSource();
        var ct = _pipeCts.Token;
        var name = PipeName;

        var thread = new Thread(() => PipeListenerLoop(name, ct))
        {
            IsBackground = true,
            Name = "WpfHotReloadPipeListener",
        };
        thread.Start();
        _pipeListenerRunning = true;
    }

    private static void PipeListenerLoop(string pipeName, CancellationToken ct)
    {
        Log($"PipeListenerLoop started, pipe={pipeName}");
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(
                    pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte);
                Log("Waiting for connection...");
                server.WaitForConnection();
                Log("Client connected");

                using var reader = new StreamReader(server, new UTF8Encoding(false));
                using var writer = new StreamWriter(server, new UTF8Encoding(false)) { AutoFlush = true };

                Log("Reading line...");
                var line = reader.ReadLine();
                Log($"Read line: {(line is null ? "(null)" : line[..Math.Min(line.Length, 100)])}");
                if (line is null)
                {
                    continue;
                }

                string result;
                try
                {
                    var request = JsonSerializer.Deserialize<PipeRequest>(line, JsonOptions);
                    if (request?.FilePath is null || request.XamlText is null)
                    {
                        result = "error: invalid request";
                    }
                    else
                    {
                        var app = Application.Current;
                        if (app is null)
                        {
                            result = "error: no current WPF application";
                        }
                        else
                        {
                            Log("Dispatching to UI thread...");
                            result = app.Dispatcher.Invoke(() => ApplyXamlTextCore(request.FilePath, request.XamlText));
                            Log($"Dispatch result: {result}");
                        }
                    }
                }
                catch (Exception ex)
                {
                    result = $"error: {ex.GetType().Name}: {ex.Message}";
                    Log($"Exception: {result}");
                }

                Log("Writing response...");
                writer.WriteLine(JsonSerializer.Serialize(new PipeResponse { Result = result }, JsonOptions));
                Log("Response written");
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log($"PipeListenerLoop error: {ex.GetType().Name}: {ex.Message}");
                // Connection broken, continue accepting
            }
        }

        _pipeListenerRunning = false;
    }

    private sealed class PipeRequest
    {
        public string? FilePath { get; set; }
        public string? XamlText { get; set; }
    }

    private sealed class PipeResponse
    {
        public string? Result { get; set; }
    }

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
            ApplyNamedSelectorStates(liveRoot, parsedRoot);
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
        liveItemsControl.DisplayMemberPath = parsedItemsControl.DisplayMemberPath;
        liveItemsControl.ItemStringFormat = parsedItemsControl.ItemStringFormat;
        liveItemsControl.ItemTemplate = parsedItemsControl.ItemTemplate;
        liveItemsControl.ItemTemplateSelector = parsedItemsControl.ItemTemplateSelector;
        liveItemsControl.ItemContainerStyle = parsedItemsControl.ItemContainerStyle;
        liveItemsControl.ItemsPanel = parsedItemsControl.ItemsPanel;
        liveItemsControl.AlternationCount = parsedItemsControl.AlternationCount;

        if (liveItemsControl is HeaderedItemsControl liveHeaderedItemsControl &&
            parsedItemsControl is HeaderedItemsControl parsedHeaderedItemsControl)
        {
            liveHeaderedItemsControl.Header = parsedHeaderedItemsControl.Header;
        }

        if (parsedItemsControl.ItemsSource is not null)
        {
            liveItemsControl.ItemsSource = parsedItemsControl.ItemsSource;
        }
        else
        {
            var items = parsedItemsControl.Items.Cast<object>().ToList();
            var liveItems = liveItemsControl.Items.Cast<object>().ToList();
            if (!TryApplyItemsInPlace(liveItemsControl, parsedItemsControl, liveItems, items))
            {
                parsedItemsControl.Items.Clear();
                liveItemsControl.Items.Clear();
                foreach (var item in items)
                {
                    liveItemsControl.Items.Add(item);
                }
            }
        }

        if (liveItemsControl is Selector liveSelector && parsedItemsControl is Selector parsedSelector)
        {
            ApplySelectorState(liveSelector, parsedSelector);
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

    private static bool TryApplyItemsInPlace(
        ItemsControl liveItemsControl,
        ItemsControl parsedItemsControl,
        IReadOnlyList<object> liveItems,
        IReadOnlyList<object> parsedItems)
    {
        var liveNamedItems = liveItems
            .Select((item, index) => new { item, index, name = GetElementName(item) })
            .Where(entry => string.IsNullOrWhiteSpace(entry.name) is false)
            .GroupBy(entry => entry.name!, StringComparer.Ordinal)
            .Where(group => group.Count() == 1)
            .ToDictionary(group => group.Key, group => (group.Single().item, group.Single().index), StringComparer.Ordinal);

        var usedLiveIndexes = new HashSet<int>();
        var reorderedItems = new List<object>(parsedItems.Count);
        var nextPositionalLiveIndex = 0;

        foreach (var parsedItem in parsedItems)
        {
            var matchingLiveItem = FindMatchingLiveItem(
                parsedItem,
                liveItems,
                liveNamedItems,
                usedLiveIndexes,
                ref nextPositionalLiveIndex);

            if (matchingLiveItem is not null)
            {
                if (!TryApplyItemObject(matchingLiveItem, parsedItem))
                {
                    return false;
                }

                reorderedItems.Add(matchingLiveItem);
                continue;
            }

            reorderedItems.Add(parsedItem);
        }

        parsedItemsControl.Items.Clear();
        for (var index = 0; index < reorderedItems.Count; index++)
        {
            var desiredItem = reorderedItems[index];
            var currentIndex = liveItemsControl.Items.IndexOf(desiredItem);
            if (currentIndex == index)
            {
                continue;
            }

            if (currentIndex >= 0)
            {
                liveItemsControl.Items.RemoveAt(currentIndex);
                liveItemsControl.Items.Insert(index, desiredItem);
                continue;
            }

            liveItemsControl.Items.Insert(index, desiredItem);
        }

        while (liveItemsControl.Items.Count > reorderedItems.Count)
        {
            liveItemsControl.Items.RemoveAt(liveItemsControl.Items.Count - 1);
        }

        return true;
    }

    private static bool TryApplyItemObject(object liveItem, object parsedItem)
    {
        if (liveItem is UIElement liveElement && parsedItem is UIElement parsedElement)
        {
            return TryApplyObject(liveElement, parsedElement);
        }

        return Equals(liveItem, parsedItem);
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
        for (var index = 0; index < reorderedChildren.Count; index++)
        {
            var desiredChild = reorderedChildren[index];
            var currentIndex = livePanel.Children.IndexOf(desiredChild);
            if (currentIndex == index)
            {
                continue;
            }

            if (currentIndex >= 0)
            {
                livePanel.Children.RemoveAt(currentIndex);
                livePanel.Children.Insert(index, desiredChild);
                continue;
            }

            livePanel.Children.Insert(index, desiredChild);
        }

        while (livePanel.Children.Count > reorderedChildren.Count)
        {
            livePanel.Children.RemoveAt(livePanel.Children.Count - 1);
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

    private static object? FindMatchingLiveItem(
        object parsedItem,
        IReadOnlyList<object> liveItems,
        IReadOnlyDictionary<string, (object item, int index)> liveNamedItems,
        ISet<int> usedLiveIndexes,
        ref int nextPositionalLiveIndex)
    {
        var parsedName = GetElementName(parsedItem);
        if (!string.IsNullOrWhiteSpace(parsedName) &&
            liveNamedItems.TryGetValue(parsedName, out var namedMatch) &&
            !usedLiveIndexes.Contains(namedMatch.index) &&
            namedMatch.item.GetType() == parsedItem.GetType())
        {
            usedLiveIndexes.Add(namedMatch.index);
            return namedMatch.item;
        }

        while (nextPositionalLiveIndex < liveItems.Count)
        {
            var liveIndex = nextPositionalLiveIndex++;
            if (usedLiveIndexes.Contains(liveIndex))
            {
                continue;
            }

            var liveItem = liveItems[liveIndex];
            if (liveItem.GetType() != parsedItem.GetType())
            {
                continue;
            }

            if (!NameMatches(liveItem, parsedItem) && !(liveItem is not UIElement && Equals(liveItem, parsedItem)))
            {
                continue;
            }

            usedLiveIndexes.Add(liveIndex);
            return liveItem;
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

    private static void ApplyNamedSelectorStates(object liveRoot, object parsedRoot)
    {
        if (liveRoot is Selector liveRootSelector && parsedRoot is Selector parsedRootSelector)
        {
            ApplySelectorState(liveRootSelector, parsedRootSelector);
        }

        if (liveRoot is not DependencyObject liveDependencyObject || parsedRoot is not DependencyObject parsedDependencyObject)
        {
            return;
        }

        foreach (var parsedSelector in EnumerateDescendants(parsedDependencyObject).OfType<Selector>())
        {
            var selectorName = GetElementName(parsedSelector);
            if (string.IsNullOrWhiteSpace(selectorName))
            {
                continue;
            }

            if (FindNamedElement(liveDependencyObject, selectorName) is Selector liveSelector)
            {
                ApplySelectorState(liveSelector, parsedSelector);
            }
        }
    }

    private static object? FindNamedElement(DependencyObject root, string name)
    {
        if (GetElementName(root) == name)
        {
            return root;
        }

        return EnumerateDescendants(root).FirstOrDefault(candidate =>
            string.Equals(GetElementName(candidate), name, StringComparison.Ordinal));
    }

    private static void ApplySelectorState(Selector liveSelector, Selector parsedSelector)
    {
        liveSelector.SelectedValuePath = parsedSelector.SelectedValuePath;
        if (parsedSelector.ItemsSource is not null &&
            parsedSelector.SelectedValue is not null &&
            parsedSelector.SelectedValue is not DependencyObject)
        {
            liveSelector.SelectedValue = parsedSelector.SelectedValue;
            return;
        }

        if (parsedSelector.SelectedIndex >= 0 && parsedSelector.SelectedIndex < liveSelector.Items.Count)
        {
            var selectedItem = liveSelector.Items[parsedSelector.SelectedIndex];
            liveSelector.SelectedItem = selectedItem;
            liveSelector.SelectedIndex = parsedSelector.SelectedIndex;
            return;
        }

        liveSelector.SelectedItem = null;
        liveSelector.SelectedIndex = -1;
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

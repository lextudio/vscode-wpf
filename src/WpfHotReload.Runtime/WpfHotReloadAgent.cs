using System.Collections;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
#if !NETFRAMEWORK
using System.Text.Json;
#endif
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Media3D;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Xaml;
using System.Xml.Linq;
using System.Xml;

namespace WpfHotReload.Runtime;

public static class WpfHotReloadAgent
{
    private static readonly object LogSync = new();
    private static volatile bool _pipeListenerRunning;
    private static CancellationTokenSource? _pipeCts;
    private static HotReloadOverlay? _overlay;
    private static bool _previewHostHiddenByAgent;
    private static int _initialHideWorkerStarted;
    private static int _overlayStartupWorkerStarted;
    private static readonly bool _startHiddenRequested = ReadBooleanEnvironmentVariable("WPF_HOTRELOAD_START_HIDDEN");
    private static readonly string? LogPath = Environment.GetEnvironmentVariable("WPF_HOTRELOAD_LOG");

    public static string PipeName { get; } =
        Environment.GetEnvironmentVariable("WPF_HOTRELOAD_PIPE")
        ?? $"wpf-hotreload-{Process.GetCurrentProcess().Id}";

#if !NETFRAMEWORK
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
#endif

    private static void Log(string message)
    {
        var line = $"[WpfHotReload] {DateTime.Now:O} {message}";
        Debug.WriteLine(line);

        if (string.IsNullOrWhiteSpace(LogPath))
        {
            return;
        }

        try
        {
            lock (LogSync)
            {
                var logDir = Path.GetDirectoryName(LogPath);
                if (!string.IsNullOrWhiteSpace(logDir))
                {
                    Directory.CreateDirectory(logDir);
                }

                File.AppendAllText(LogPath, line + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // Never let diagnostics break the host app.
        }
    }

    /// <summary>
    /// Called by StartupHook once Application.Current is available.
    /// Safe to call multiple times — only the first call starts the listener.
    /// </summary>
    public static void EnsurePipeListenerStarted()
    {
        Log($"EnsurePipeListenerStarted called, already running={_pipeListenerRunning}");
        EnsureStartHiddenWorker();
        EnsureOverlayStartupWorker();
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
        Log($"Pipe listener thread started for {name}");
    }

    private static bool ReadBooleanEnvironmentVariable(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "on", StringComparison.OrdinalIgnoreCase);
    }

    private static void EnsureStartHiddenWorker()
    {
        if (!_startHiddenRequested)
        {
            return;
        }

        if (Interlocked.Exchange(ref _initialHideWorkerStarted, 1) != 0)
        {
            return;
        }

        var worker = new Thread(HidePreviewHostOnStartupLoop)
        {
            IsBackground = true,
            Name = "WpfHotReloadInitialHide",
        };
        worker.Start();
    }

    /// <summary>
    /// Starts a one-time background thread that polls until the main window is loaded
    /// and then injects the overlay toolbar.  This runs independently of any pipe
    /// connection so the overlay appears as soon as the app starts, not only after
    /// the first Hot Reload click.
    /// </summary>
    private static void EnsureOverlayStartupWorker()
    {
        if (Interlocked.Exchange(ref _overlayStartupWorkerStarted, 1) != 0)
        {
            return;
        }

        var worker = new Thread(InjectOverlayOnStartupLoop)
        {
            IsBackground = true,
            Name = "WpfHotReloadOverlayInit",
        };
        worker.Start();
    }

    private static void InjectOverlayOnStartupLoop()
    {
        var startedAt = Stopwatch.StartNew();
        while (startedAt.Elapsed < TimeSpan.FromSeconds(30))
        {
            try
            {
                var app = Application.Current;
                if (app is not null)
                {
                    bool injected = app.Dispatcher.Invoke(() =>
                    {
                        if (_overlay is not null)
                        {
                            return true; // already done
                        }

                        var mainWindow = app.MainWindow;
                        if (mainWindow is null || !mainWindow.IsLoaded)
                        {
                            return false;
                        }

                        InjectOverlay(mainWindow);
                        return _overlay is not null;
                    });

                    if (injected)
                    {
                        return;
                    }
                }
            }
            catch
            {
                // Keep retrying while app startup stabilizes.
            }

            Thread.Sleep(100);
        }
    }

    private static void HidePreviewHostOnStartupLoop()
    {
        var startedAt = Stopwatch.StartNew();
        while (startedAt.Elapsed < TimeSpan.FromSeconds(12))
        {
            try
            {
                var app = Application.Current;
                if (app is not null)
                {
                    var hidden = app.Dispatcher.Invoke(TryHidePreviewHostImmediately, DispatcherPriority.Send);
                    if (hidden)
                    {
                        return;
                    }
                }
            }
            catch
            {
                // Keep retrying while app startup stabilizes.
            }

            Thread.Sleep(75);
        }
    }

    private static bool TryHidePreviewHostImmediately()
    {
        if (!_startHiddenRequested)
        {
            return false;
        }

        var window = ResolvePreviewHostWindow();
        if (window is null)
        {
            return false;
        }

        if (!window.IsLoaded)
        {
            window.Loaded -= OnPreviewHostLoadedHide;
            window.Loaded += OnPreviewHostLoadedHide;
            return false;
        }

        if (window.Visibility == Visibility.Visible)
        {
            window.Hide();
        }

        _previewHostHiddenByAgent = window.Visibility != Visibility.Visible;
        return _previewHostHiddenByAgent;
    }

    private static void OnPreviewHostLoadedHide(object? sender, RoutedEventArgs args)
    {
        if (sender is not Window window)
        {
            return;
        }

        window.Loaded -= OnPreviewHostLoadedHide;
        if (!_startHiddenRequested)
        {
            return;
        }

        if (window.Visibility == Visibility.Visible)
        {
            window.Hide();
        }

        _previewHostHiddenByAgent = window.Visibility != Visibility.Visible;
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

                // Inject the overlay toolbar on first connection (if not already injected).
                EnsureOverlayInjected();

                using var reader = new StreamReader(server, new UTF8Encoding(false));
                using var writer = new StreamWriter(server, new UTF8Encoding(false)) { AutoFlush = true };

                Log("Reading line...");
                var line = reader.ReadLine();
                Log($"Read line: {(line is null ? "(null)" : line.Substring(0, Math.Min(line.Length, 100)))}");
                if (line is null)
                {
                    continue;
                }

                string result;
                string? responseValue = null;
                try
                {
                    var request = DeserializePipeRequest(line);
                    if (request is null)
                    {
                        result = "error: invalid request";
                    }
                    else if (string.Equals(request.Kind, "query", StringComparison.Ordinal))
                    {
                        result = "ok";
                        responseValue = QueryValue(request.Query);
                    }
                    else if (string.Equals(request.Kind, "preview", StringComparison.Ordinal))
                    {
                        var app = Application.Current;
                        if (app is null)
                        {
                            result = "error: no current WPF application";
                        }
                        else
                        {
                            PreviewCaptureResult previewResult;
                            if (string.Equals(request.Action, "hitTest", StringComparison.Ordinal))
                            {
                                previewResult = app.Dispatcher.Invoke(() => HitTestPreviewElement(request.FilePath, request.XNorm, request.YNorm));
                            }
                            else if (string.Equals(request.Action, "setHostVisibility", StringComparison.Ordinal))
                            {
                                previewResult = app.Dispatcher.Invoke(() => SetPreviewHostVisibility(request.Query));
                            }
                            else if (string.Equals(request.Action, "inspect", StringComparison.Ordinal))
                            {
                                previewResult = app.Dispatcher.Invoke(() => InspectPreviewElement(request.Query));
                            }
                            else if (string.Equals(request.Action, "find", StringComparison.Ordinal))
                            {
                                previewResult = app.Dispatcher.Invoke(() => FindPreviewElement(request.Query));
                            }
                            else
                            {
                                previewResult = app.Dispatcher.Invoke(() => CapturePreviewFrame(request.FilePath));
                            }

                            if (previewResult.Result.StartsWith("ok", StringComparison.Ordinal))
                            {
                                result = "ok";
                                responseValue = previewResult.Value;
                            }
                            else
                            {
                                result = previewResult.Result;
                            }
                        }
                    }
                    else if (request.FilePath is null || request.XamlText is null)
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
                            app.Dispatcher.Invoke(() => UpdateOverlayStatus(OverlayState.Applying, "Applying\u2026"));
                            result = app.Dispatcher.Invoke(() => ApplyXamlTextCore(request.FilePath, request.XamlText));
                            Log($"Dispatch result: {result}");
                            if (result.StartsWith("ok", StringComparison.Ordinal))
                            {
                                app.Dispatcher.Invoke(() => UpdateOverlayStatus(OverlayState.Applied, "Updated"));
                            }
                            else
                            {
                                app.Dispatcher.Invoke(() => UpdateOverlayStatus(OverlayState.Error, result));
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    result = $"error: {ex.GetType().Name}: {ex.Message}";
                    Log($"Exception: {result}");
                }

                Log("Writing response...");
                writer.WriteLine(SerializePipeResponse(result, responseValue));
                Log("Response written");
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log($"PipeListenerLoop error: {ex}");
                // Connection broken, continue accepting
            }
        }

        _pipeListenerRunning = false;
        Log($"PipeListenerLoop stopped, pipe={pipeName}");
    }

    private sealed class PipeRequest
    {
        public string? Kind { get; set; }
        public string? Action { get; set; }
        public string? FilePath { get; set; }
        public string? XamlText { get; set; }
        public string? Query { get; set; }
        public string? XNorm { get; set; }
        public string? YNorm { get; set; }
    }

    private sealed class PipeResponse
    {
        public string? Result { get; set; }
        public string? Value { get; set; }
    }

    private sealed class PreviewFrame
    {
        public string PngBase64 { get; set; } = string.Empty;
        public int Width { get; set; }
        public int Height { get; set; }
        public string Source { get; set; } = "runtime-main-window";
    }

    private sealed class PreviewCaptureResult
    {
        public string Result { get; set; } = "error: unknown";
        public string? Value { get; set; }
    }

    private sealed class PreviewHit
    {
        public string TypeName { get; set; } = string.Empty;
        public string ElementName { get; set; } = string.Empty;
        public double BoundsX { get; set; }
        public double BoundsY { get; set; }
        public double BoundsWidth { get; set; }
        public double BoundsHeight { get; set; }
        public double RootWidth { get; set; }
        public double RootHeight { get; set; }
    }

    private sealed class PreviewProperties
    {
        public string TypeName { get; set; } = string.Empty;
        public string ElementName { get; set; } = string.Empty;
        public string Text { get; set; } = string.Empty;
        public string Background { get; set; } = string.Empty;
        public string Foreground { get; set; } = string.Empty;
        public string Width { get; set; } = string.Empty;
        public string Height { get; set; } = string.Empty;
        public string ActualWidth { get; set; } = string.Empty;
        public string ActualHeight { get; set; } = string.Empty;
        public string Margin { get; set; } = string.Empty;
        public string HorizontalAlignment { get; set; } = string.Empty;
        public string VerticalAlignment { get; set; } = string.Empty;
        public string IsEnabled { get; set; } = string.Empty;
        public string Visibility { get; set; } = string.Empty;
        public string CanEditText { get; set; } = "False";
        public string CanEditBackground { get; set; } = "False";
        public string CanEditForeground { get; set; } = "False";
    }

    // ── Overlay toolbar ──────────────────────────────────────────────────

    internal enum OverlayState
    {
        Connected,
        Applying,
        Applied,
        Error,
        Disconnected,
    }

    /// <summary>
    /// Called from the pipe listener's background thread to inject the overlay
    /// into the WPF app once Application.Current and MainWindow are available.
    /// </summary>
    internal static void EnsureOverlayInjected()
    {
        var app = Application.Current;
        if (app is null)
        {
            return;
        }

        app.Dispatcher.Invoke(() =>
        {
            if (_overlay is not null)
            {
                return;
            }

            var mainWindow = app.MainWindow;
            if (mainWindow is null || !mainWindow.IsLoaded)
            {
                // Retry when the window finishes loading.
                if (mainWindow is not null)
                {
                    mainWindow.Loaded += (_, _) =>
                    {
                        if (_overlay is null)
                        {
                            InjectOverlay(mainWindow);
                        }
                    };
                }
                return;
            }

            InjectOverlay(mainWindow);
        });
    }

    private static void InjectOverlay(Window mainWindow)
    {
        try
        {
            var adornerLayer = AdornerLayer.GetAdornerLayer(mainWindow.Content as UIElement);
            if (adornerLayer is not null && mainWindow.Content is UIElement rootElement)
            {
                _overlay = new HotReloadOverlay(rootElement);
                adornerLayer.Add(_overlay);
                Log("Overlay toolbar injected via AdornerLayer.");
            }
            else
            {
                // Fallback: inject as a Popup
                _overlay = null;
                Log("AdornerLayer not available; overlay toolbar skipped.");
            }
        }
        catch (Exception ex)
        {
            Log($"Failed to inject overlay toolbar: {ex.Message}");
        }
    }

    private static void UpdateOverlayStatus(OverlayState state, string message)
    {
        _overlay?.UpdateStatus(state, message);
    }

    /// <summary>
    /// A lightweight adorner that displays a hot reload status bar at the top of the window.
    /// </summary>
    private sealed class HotReloadOverlay : Adorner
    {
        private readonly Border _border;
        private readonly TextBlock _label;
        private DispatcherTimer? _fadeTimer;
        private bool _collapsed;

        // Drag state
        private bool _isDragging;
        private Point _dragStart;      // mouse position when drag began (relative to adorner)
        private Point _position;       // top-left of the border in adorner coordinates
        private bool _positionSet;     // false until the user first drags (use default centering until then)

        public HotReloadOverlay(UIElement adornedElement) : base(adornedElement)
        {
            IsHitTestVisible = true;

            _label = new TextBlock
            {
                Text = "\U0001F525 Hot Reload",
                Foreground = Brushes.White,
                FontSize = 11,
                FontFamily = new FontFamily("Segoe UI"),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(6, 0, 0, 0),
            };

            var collapseButton = new Button
            {
                Content = "\u2715",
                FontSize = 10,
                Foreground = Brushes.White,
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(0),
                Cursor = System.Windows.Input.Cursors.Hand,
                Padding = new Thickness(4, 0, 4, 0),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(4, 0, 4, 0),
            };
            collapseButton.Click += (_, _) => ToggleCollapse();

            var panel = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Children = { _label, collapseButton },
            };

            _border = new Border
            {
                Background = new SolidColorBrush(Color.FromArgb(200, 40, 40, 40)),
                CornerRadius = new CornerRadius(4),
                Padding = new Thickness(4, 2, 4, 2),
                Cursor = System.Windows.Input.Cursors.SizeAll,
                Child = panel,
            };

            _border.MouseLeftButtonDown += OnBorderMouseDown;
            _border.MouseLeftButtonUp += OnBorderMouseUp;
            _border.MouseMove += OnBorderMouseMove;

            AddVisualChild(_border);
        }

        private void OnBorderMouseDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            _isDragging = true;
            _dragStart = e.GetPosition(this);
            // Capture so we keep getting events if the mouse leaves the border
            _border.CaptureMouse();
            e.Handled = true;
        }

        private void OnBorderMouseUp(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            if (!_isDragging) return;
            _isDragging = false;
            _border.ReleaseMouseCapture();
            e.Handled = true;
        }

        private void OnBorderMouseMove(object sender, System.Windows.Input.MouseEventArgs e)
        {
            if (!_isDragging) return;

            var current = e.GetPosition(this);
            var delta = current - _dragStart;

            var newX = _position.X + delta.X;
            var newY = _position.Y + delta.Y;

            // Clamp so the toolbar stays inside the adorned element bounds
            var adornerSize = RenderSize;
            var borderSize = _border.RenderSize;
            newX = Math.Max(0, Math.Min(newX, adornerSize.Width - borderSize.Width));
            newY = Math.Max(0, Math.Min(newY, adornerSize.Height - borderSize.Height));

            _position = new Point(newX, newY);
            _positionSet = true;
            _dragStart = current;

            InvalidateArrange();
            InvalidateVisual();
            e.Handled = true;
        }

        public void UpdateStatus(OverlayState state, string message)
        {
            _fadeTimer?.Stop();

            if (_collapsed && state != OverlayState.Error)
            {
                return;
            }

            switch (state)
            {
                case OverlayState.Connected:
                    _label.Text = "\U0001F525 Hot Reload";
                    _border.Background = new SolidColorBrush(Color.FromArgb(200, 40, 40, 40));
                    break;
                case OverlayState.Applying:
                    _label.Text = "\u27F3 Applying\u2026";
                    _border.Background = new SolidColorBrush(Color.FromArgb(200, 30, 80, 160));
                    break;
                case OverlayState.Applied:
                    _label.Text = "\u2713 Updated";
                    _border.Background = new SolidColorBrush(Color.FromArgb(200, 30, 120, 50));
                    // Revert to idle after 2 seconds
                    _fadeTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
                    _fadeTimer.Tick += (_, _) =>
                    {
                        _fadeTimer.Stop();
                        UpdateStatus(OverlayState.Connected, "");
                    };
                    _fadeTimer.Start();
                    break;
                case OverlayState.Error:
                    _label.Text = "\u2717 Error";
                    _label.ToolTip = message;
                    _border.Background = new SolidColorBrush(Color.FromArgb(200, 160, 30, 30));
                    break;
                case OverlayState.Disconnected:
                    _label.Text = "\u25CB Disconnected";
                    _border.Background = new SolidColorBrush(Color.FromArgb(200, 120, 120, 40));
                    break;
            }
        }

        private void ToggleCollapse()
        {
            _collapsed = !_collapsed;
            _label.Visibility = _collapsed ? Visibility.Collapsed : Visibility.Visible;
            if (_collapsed)
            {
                _label.Text = "\U0001F525";
            }
            else
            {
                UpdateStatus(OverlayState.Connected, "");
            }
        }

        protected override int VisualChildrenCount => 1;

        protected override Visual GetVisualChild(int index) => _border;

        protected override Size MeasureOverride(Size constraint)
        {
            _border.Measure(constraint);
            return _border.DesiredSize;
        }

        protected override Size ArrangeOverride(Size finalSize)
        {
            var borderSize = _border.DesiredSize;

            Point origin;
            if (_positionSet)
            {
                // Clamp to keep the toolbar fully visible after window resize
                var x = Math.Max(0, Math.Min(_position.X, finalSize.Width - borderSize.Width));
                var y = Math.Max(0, Math.Min(_position.Y, finalSize.Height - borderSize.Height));
                origin = new Point(x, y);
            }
            else
            {
                // Default: centered horizontally at the top
                origin = new Point((finalSize.Width - borderSize.Width) / 2, 0);
            }

            _border.Arrange(new Rect(origin, borderSize));

            // Keep _position in sync with the clamped origin so dragging starts correctly
            _position = origin;

            return finalSize;
        }
    }

    // ── End overlay ──────────────────────────────────────────────────────

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

        // Fast/safe path first: apply named element property updates directly from XML.
        // This avoids object graph reconstruction and prevents debugger-breaking first-chance
        // exceptions for simple edits (e.g. colors/text/margins).
        if (TryApplyNamedElementPropertyUpdates(sanitizedXaml, out var xmlFallbackMessage))
        {
            return $"ok: {xmlFallbackMessage}";
        }

        object parsedRoot;
        try
        {
            parsedRoot = ParseXamlIgnoringEventMembers(sanitizedXaml);
        }
        catch (Exception ex)
        {
            var innerMessage = ex.InnerException?.Message;
            return innerMessage is null
                ? $"error: parse failed ({ex.GetType().Name}): {ex.Message}"
                : $"error: parse failed ({ex.GetType().Name}): {ex.Message} | inner: {innerMessage}";
        }

        var liveRoot = FindLiveRoot(filePath, xClass, parsedRoot);
        if (liveRoot is null)
        {
            return $"error: no live root matched {xClass ?? filePath}";
        }

        return ApplyParsedRoot(liveRoot, parsedRoot);
    }

    private static string? QueryValue(string? query)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return null;
        }

        return query switch
        {
            "agent.ready" => "1",
            "PrimaryButton.Background" => DescribeBrushColor(FindNamedElement(Application.Current?.MainWindow, "PrimaryButton") as Control),
            "PaneTitle.Text" => (FindNamedElement(Application.Current?.MainWindow, "PaneTitle") as TextBlock)?.Text,
            "PaneBody.Text" => (FindNamedElement(Application.Current?.MainWindow, "PaneBody") as TextBlock)?.Text,
            "PaneList.SelectedIndex" => DescribeSelectorIndex(FindNamedElement(Application.Current?.MainWindow, "PaneList") as Selector),
            _ => null,
        };
    }

    private static PipeRequest? DeserializePipeRequest(string line)
    {
#if NETFRAMEWORK
        return ParsePipeRequest(line);
#else
        return JsonSerializer.Deserialize<PipeRequest>(line, JsonOptions);
#endif
    }

    private static string SerializePipeResponse(string result, string? value)
    {
#if NETFRAMEWORK
        return ToJsonString("result", result, "value", value);
#else
        return JsonSerializer.Serialize(new PipeResponse { Result = result, Value = value }, JsonOptions);
#endif
    }

    private static string SerializePreviewFrame(PreviewFrame frame)
    {
#if NETFRAMEWORK
        return ToJsonString("pngBase64", frame.PngBase64, "width", frame.Width.ToString(), "height", frame.Height.ToString(), "source", frame.Source);
#else
        return JsonSerializer.Serialize(frame, JsonOptions);
#endif
    }

    private static string SerializePreviewHit(PreviewHit hit)
    {
#if NETFRAMEWORK
        return ToJsonString(
            "typeName", hit.TypeName,
            "elementName", hit.ElementName,
            "boundsX", hit.BoundsX.ToString(CultureInfo.InvariantCulture),
            "boundsY", hit.BoundsY.ToString(CultureInfo.InvariantCulture),
            "boundsWidth", hit.BoundsWidth.ToString(CultureInfo.InvariantCulture),
            "boundsHeight", hit.BoundsHeight.ToString(CultureInfo.InvariantCulture),
            "rootWidth", hit.RootWidth.ToString(CultureInfo.InvariantCulture),
            "rootHeight", hit.RootHeight.ToString(CultureInfo.InvariantCulture));
#else
        return JsonSerializer.Serialize(hit, JsonOptions);
#endif
    }

    private static string SerializePreviewProperties(PreviewProperties properties)
    {
#if NETFRAMEWORK
        return ToJsonString(
            "typeName", properties.TypeName,
            "elementName", properties.ElementName,
            "text", properties.Text,
            "background", properties.Background,
            "foreground", properties.Foreground,
            "width", properties.Width,
            "height", properties.Height,
            "actualWidth", properties.ActualWidth,
            "actualHeight", properties.ActualHeight,
            "margin", properties.Margin,
            "horizontalAlignment", properties.HorizontalAlignment,
            "verticalAlignment", properties.VerticalAlignment,
            "isEnabled", properties.IsEnabled,
            "visibility", properties.Visibility,
            "canEditText", properties.CanEditText,
            "canEditBackground", properties.CanEditBackground,
            "canEditForeground", properties.CanEditForeground);
#else
        return JsonSerializer.Serialize(properties, JsonOptions);
#endif
    }

#if NETFRAMEWORK
    private static PipeRequest? ParsePipeRequest(string json)
    {
        try
        {
            var request = new PipeRequest();
            int pos = 0;
            while (pos < json.Length)
            {
                // Find the next key string
                int keyOpen = json.IndexOf('"', pos);
                if (keyOpen < 0) break;
                int keyClose = FindJsonStringEnd(json, keyOpen + 1);
                if (keyClose < 0) break;
                string key = UnescapeJsonString(json, keyOpen + 1, keyClose);
                pos = keyClose + 1;

                // Skip ':' separator
                int colon = json.IndexOf(':', pos);
                if (colon < 0) break;
                pos = colon + 1;

                // Find opening '"' of the value
                int valueOpen = json.IndexOf('"', pos);
                if (valueOpen < 0) break;
                int valueClose = FindJsonStringEnd(json, valueOpen + 1);
                if (valueClose < 0) break;
                string value = UnescapeJsonString(json, valueOpen + 1, valueClose);
                pos = valueClose + 1;

                switch (key)
                {
                    case "kind": request.Kind = value; break;
                    case "action": request.Action = value; break;
                    case "filePath": request.FilePath = value; break;
                    case "xamlText": request.XamlText = value; break;
                    case "query": request.Query = value; break;
                    case "xNorm": request.XNorm = value; break;
                    case "yNorm": request.YNorm = value; break;
                }
            }
            return request;
        }
        catch { return null; }
    }

    // Returns the index of the closing unescaped '"', scanning from 'start'
    // (the character immediately after the opening '"').
    private static int FindJsonStringEnd(string s, int start)
    {
        for (int i = start; i < s.Length; i++)
        {
            if (s[i] == '\\') { i++; continue; } // skip escaped character
            if (s[i] == '"') return i;
        }
        return -1;
    }

    private static string UnescapeJsonString(string s, int start, int end)
    {
        var sb = new StringBuilder(end - start);
        for (int i = start; i < end; i++)
        {
            if (s[i] == '\\' && i + 1 < end)
            {
                i++;
                switch (s[i])
                {
                    case '"':  sb.Append('"');  break;
                    case '\\': sb.Append('\\'); break;
                    case '/':  sb.Append('/');  break;
                    case 'n':  sb.Append('\n'); break;
                    case 'r':  sb.Append('\r'); break;
                    case 't':  sb.Append('\t'); break;
                    default:   sb.Append('\\'); sb.Append(s[i]); break;
                }
            }
            else
            {
                sb.Append(s[i]);
            }
        }
        return sb.ToString();
    }

    private static string ToJsonString(params string[] pairs)
    {
        var sb = new StringBuilder("{");
        for (int i = 0; i < pairs.Length; i += 2)
        {
            if (i > 0) sb.Append(",");
            sb.Append("\"").Append(pairs[i]).Append("\":");
            var val = pairs[i + 1];
            if (val == null) sb.Append("null");
            else sb.Append("\"").Append(val.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\"");
        }
        sb.Append("}");
        return sb.ToString();
    }
#endif

    private static PreviewCaptureResult CapturePreviewFrame(string? filePath)
    {
        try
        {
            var window = ResolvePreviewWindow();
            if (window is null)
            {
                return new PreviewCaptureResult { Result = "error: no active preview window" };
            }

            window.UpdateLayout();

            // Capture the content root so the frame reflects actual app visuals.
            var visual = window.Content as Visual ?? window;
            var width = (int)Math.Ceiling(Math.Max(1, window.ActualWidth));
            var height = (int)Math.Ceiling(Math.Max(1, window.ActualHeight));

            if (visual == window.Content && window.Content is FrameworkElement rootElement)
            {
                rootElement.UpdateLayout();
                width = (int)Math.Ceiling(Math.Max(1, rootElement.ActualWidth));
                height = (int)Math.Ceiling(Math.Max(1, rootElement.ActualHeight));
            }

            var rtb = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
            rtb.Render(visual);

            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(rtb));
            using var ms = new MemoryStream();
            encoder.Save(ms);

            var frame = new PreviewFrame
            {
                PngBase64 = Convert.ToBase64String(ms.ToArray()),
                Width = width,
                Height = height,
                Source = string.IsNullOrWhiteSpace(filePath) ? "runtime-main-window" : $"runtime:{Path.GetFileName(filePath)}",
            };

            return new PreviewCaptureResult
            {
                Result = "ok",
                Value = SerializePreviewFrame(frame),
            };
        }
        catch (Exception ex)
        {
            return new PreviewCaptureResult
            {
                Result = $"error: preview capture failed ({ex.GetType().Name}): {ex.Message}",
            };
        }
    }

    private static PreviewCaptureResult HitTestPreviewElement(string? filePath, string? xNormText, string? yNormText)
    {
        try
        {
            var window = ResolvePreviewWindow();
            if (window is null)
            {
                return new PreviewCaptureResult { Result = "error: no active preview window" };
            }

            var root = window.Content as FrameworkElement;
            if (root is null)
            {
                return new PreviewCaptureResult { Result = "error: preview root is unavailable" };
            }

            root.UpdateLayout();
            var rootWidth = Math.Max(1, root.ActualWidth);
            var rootHeight = Math.Max(1, root.ActualHeight);

            if (!double.TryParse(xNormText, NumberStyles.Float, CultureInfo.InvariantCulture, out var xNorm) ||
                !double.TryParse(yNormText, NumberStyles.Float, CultureInfo.InvariantCulture, out var yNorm))
            {
                return new PreviewCaptureResult { Result = "error: invalid hit-test coordinates" };
            }

            xNorm = Math.Max(0, Math.Min(1, xNorm));
            yNorm = Math.Max(0, Math.Min(1, yNorm));

            var point = new Point(xNorm * rootWidth, yNorm * rootHeight);
            var targetElement = ResolvePreviewHitTarget(root, point);
            if (targetElement is null)
            {
                return new PreviewCaptureResult { Result = "error: no selectable framework element found" };
            }

            var bounds = GetBoundsInRoot(targetElement, root);
            var hit = new PreviewHit
            {
                TypeName = targetElement.GetType().FullName ?? targetElement.GetType().Name,
                ElementName = targetElement.Name ?? string.Empty,
                BoundsX = bounds.X,
                BoundsY = bounds.Y,
                BoundsWidth = bounds.Width,
                BoundsHeight = bounds.Height,
                RootWidth = rootWidth,
                RootHeight = rootHeight,
            };

            return new PreviewCaptureResult
            {
                Result = "ok",
                Value = SerializePreviewHit(hit),
            };
        }
        catch (Exception ex)
        {
            return new PreviewCaptureResult
            {
                Result = $"error: preview hit-test failed ({ex.GetType().Name}): {ex.Message}",
            };
        }
    }

    private static FrameworkElement? ResolvePreviewHitTarget(FrameworkElement root, Point point)
    {
        // Primary path: use WPF input hit testing when available.
        if (root.InputHitTest(point) is DependencyObject hitDependency)
        {
            var direct = FindNearestFrameworkElement(hitDependency);
            var promoted = PromotePreviewHitElement(direct, root);
            if (promoted is not null)
            {
                return promoted;
            }
        }

        // Fallback path: hidden preview hosts can return null from InputHitTest.
        // In that case, resolve by geometry using rendered bounds.
        var bestMatch = EnumerateFrameworkElementCandidates(root)
            .Select(element => new
            {
                Element = PromotePreviewHitElement(element, root),
                Bounds = GetBoundsInRoot(element, root),
                Depth = GetVisualDepth(element, root),
            })
            .Where(entry => entry.Element is not null
                && entry.Bounds.Width > 0
                && entry.Bounds.Height > 0
                && entry.Bounds.Contains(point))
            .OrderByDescending(entry => entry.Depth)
            .ThenBy(entry => entry.Bounds.Width * entry.Bounds.Height)
            .FirstOrDefault();

        return bestMatch?.Element;
    }

    private static FrameworkElement? PromotePreviewHitElement(FrameworkElement? element, FrameworkElement root)
    {
        if (element is null)
        {
            return null;
        }

        var current = element as DependencyObject;
        FrameworkElement? firstFrameworkElement = element;
        while (current is not null)
        {
            if (current is FrameworkElement frameworkElement)
            {
                firstFrameworkElement ??= frameworkElement;
                if (frameworkElement is Control)
                {
                    return frameworkElement;
                }

                if (ReferenceEquals(frameworkElement, root))
                {
                    break;
                }
            }

            current = GetDependencyParent(current);
        }

        return firstFrameworkElement;
    }

    private static int GetVisualDepth(DependencyObject element, FrameworkElement root)
    {
        var depth = 0;
        DependencyObject? current = element;
        while (current is not null && !ReferenceEquals(current, root))
        {
            depth++;
            current = GetDependencyParent(current);
        }

        return depth;
    }

    private static DependencyObject? GetDependencyParent(DependencyObject current)
    {
        if (current is Visual || current is Visual3D)
        {
            var visualParent = VisualTreeHelper.GetParent(current);
            if (visualParent is not null)
            {
                return visualParent;
            }
        }

        return LogicalTreeHelper.GetParent(current) as DependencyObject;
    }

    private static PreviewCaptureResult FindPreviewElement(string? query)
    {
        try
        {
            var window = ResolvePreviewWindow();
            if (window is null)
            {
                return new PreviewCaptureResult { Result = "error: no active preview window" };
            }

            var root = window.Content as FrameworkElement;
            if (root is null)
            {
                return new PreviewCaptureResult { Result = "error: preview root is unavailable" };
            }

            root.UpdateLayout();
            var rootWidth = Math.Max(1, root.ActualWidth);
            var rootHeight = Math.Max(1, root.ActualHeight);

            ParseFindQuery(query, out var requestedName, out var requestedType);
            if (string.IsNullOrWhiteSpace(requestedName) && string.IsNullOrWhiteSpace(requestedType))
            {
                return new PreviewCaptureResult { Result = "error: invalid find query" };
            }

            var targetElement = ResolvePreviewTarget(root, requestedName, requestedType, out var resolveError);
            if (targetElement is null)
            {
                return new PreviewCaptureResult { Result = resolveError ?? "error: no preview element matched query" };
            }

            var bounds = GetBoundsInRoot(targetElement, root);
            var hit = new PreviewHit
            {
                TypeName = targetElement.GetType().FullName ?? targetElement.GetType().Name,
                ElementName = targetElement.Name ?? string.Empty,
                BoundsX = bounds.X,
                BoundsY = bounds.Y,
                BoundsWidth = bounds.Width,
                BoundsHeight = bounds.Height,
                RootWidth = rootWidth,
                RootHeight = rootHeight,
            };

            return new PreviewCaptureResult
            {
                Result = "ok",
                Value = SerializePreviewHit(hit),
            };
        }
        catch (Exception ex)
        {
            return new PreviewCaptureResult
            {
                Result = $"error: preview find failed ({ex.GetType().Name}): {ex.Message}",
            };
        }
    }

    private static PreviewCaptureResult InspectPreviewElement(string? query)
    {
        try
        {
            var window = ResolvePreviewWindow();
            if (window is null)
            {
                return new PreviewCaptureResult { Result = "error: no active preview window" };
            }

            var root = window.Content as FrameworkElement;
            if (root is null)
            {
                return new PreviewCaptureResult { Result = "error: preview root is unavailable" };
            }

            root.UpdateLayout();
            ParseFindQuery(query, out var requestedName, out var requestedType);
            if (string.IsNullOrWhiteSpace(requestedName) && string.IsNullOrWhiteSpace(requestedType))
            {
                return new PreviewCaptureResult { Result = "error: invalid inspect query" };
            }

            var targetElement = ResolvePreviewTarget(root, requestedName, requestedType, out var resolveError);
            if (targetElement is null)
            {
                return new PreviewCaptureResult { Result = resolveError ?? "error: no preview element matched query" };
            }

            var properties = new PreviewProperties
            {
                TypeName = targetElement.GetType().FullName ?? targetElement.GetType().Name,
                ElementName = targetElement.Name ?? string.Empty,
                Text = DescribeElementText(targetElement),
                Background = DescribeElementBackground(targetElement),
                Foreground = DescribeElementForeground(targetElement),
                Width = DescribeSizeValue(targetElement.Width),
                Height = DescribeSizeValue(targetElement.Height),
                ActualWidth = DescribeSizeValue(targetElement.ActualWidth),
                ActualHeight = DescribeSizeValue(targetElement.ActualHeight),
                Margin = DescribeThickness(targetElement.Margin),
                HorizontalAlignment = targetElement.HorizontalAlignment.ToString(),
                VerticalAlignment = targetElement.VerticalAlignment.ToString(),
                IsEnabled = targetElement.IsEnabled ? "True" : "False",
                Visibility = targetElement.Visibility.ToString(),
                CanEditText = SupportsTextEdit(targetElement) ? "True" : "False",
                CanEditBackground = SupportsBackgroundEdit(targetElement) ? "True" : "False",
                CanEditForeground = SupportsForegroundEdit(targetElement) ? "True" : "False",
            };

            return new PreviewCaptureResult
            {
                Result = "ok",
                Value = SerializePreviewProperties(properties),
            };
        }
        catch (Exception ex)
        {
            return new PreviewCaptureResult
            {
                Result = $"error: preview inspect failed ({ex.GetType().Name}): {ex.Message}",
            };
        }
    }

    private static PreviewCaptureResult SetPreviewHostVisibility(string? query)
    {
        var hide = string.Equals(query, "hidden", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(query, "hide", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(query, "1", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(query, "true", StringComparison.OrdinalIgnoreCase);
        var show = string.Equals(query, "visible", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(query, "show", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(query, "0", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(query, "false", StringComparison.OrdinalIgnoreCase);

        if (!hide && !show)
        {
            return new PreviewCaptureResult
            {
                Result = "error: invalid host visibility query",
            };
        }

        var window = ResolvePreviewHostWindow();
        if (window is null)
        {
            return new PreviewCaptureResult
            {
                Result = "error: no preview host window",
            };
        }

        if (hide)
        {
            if (window.Visibility == Visibility.Visible)
            {
                window.Hide();
                _previewHostHiddenByAgent = true;
            }

            return new PreviewCaptureResult
            {
                Result = "ok",
                Value = "hidden",
            };
        }

        if (_previewHostHiddenByAgent && window.Visibility != Visibility.Visible)
        {
            window.Show();
        }

        _previewHostHiddenByAgent = false;
        return new PreviewCaptureResult
        {
            Result = "ok",
            Value = "visible",
        };
    }

    private static Window? ResolvePreviewWindow()
    {
        var app = Application.Current;
        if (app is null)
        {
            return null;
        }

        if (app.MainWindow is Window mainWindow &&
            mainWindow.IsLoaded &&
            mainWindow.Visibility == Visibility.Visible)
        {
            return mainWindow;
        }

        var candidate = app.Windows
            .OfType<Window>()
            .FirstOrDefault(w => w.IsLoaded && w.IsActive && w.Visibility == Visibility.Visible);
        if (candidate is not null)
        {
            return candidate;
        }

        candidate = app.Windows
            .OfType<Window>()
            .FirstOrDefault(w => w.IsLoaded && w.Visibility == Visibility.Visible);
        if (candidate is not null)
        {
            return candidate;
        }

        return app.MainWindow
            ?? app.Windows.OfType<Window>().FirstOrDefault();
    }

    private static Window? ResolvePreviewHostWindow()
    {
        var app = Application.Current;
        if (app is null)
        {
            return null;
        }

        if (app.MainWindow is Window mainWindow && mainWindow.IsLoaded)
        {
            return mainWindow;
        }

        return app.Windows
            .OfType<Window>()
            .FirstOrDefault(window => window.IsLoaded)
            ?? app.MainWindow
            ?? app.Windows.OfType<Window>().FirstOrDefault();
    }

    private static FrameworkElement? ResolvePreviewTarget(
        FrameworkElement root,
        string requestedName,
        string requestedType,
        out string? error)
    {
        error = null;
        FrameworkElement? targetElement = null;
        var candidates = EnumerateFrameworkElementCandidates(root).ToList();

        if (!string.IsNullOrWhiteSpace(requestedName))
        {
            var namedMatches = candidates.Where(candidate =>
                string.Equals(candidate.Name, requestedName, StringComparison.Ordinal)).ToList();
            if (namedMatches.Count > 1)
            {
                error = "error: ambiguous preview element name match";
                return null;
            }

            if (namedMatches.Count == 1)
            {
                targetElement = namedMatches[0];
            }
        }

        if (targetElement is null && !string.IsNullOrWhiteSpace(requestedType))
        {
            var typedMatches = candidates.Where(candidate =>
                string.Equals(candidate.GetType().Name, requestedType, StringComparison.Ordinal) ||
                string.Equals(candidate.GetType().FullName, requestedType, StringComparison.Ordinal) ||
                candidate.GetType().FullName?.EndsWith("." + requestedType, StringComparison.Ordinal) == true).ToList();
            if (typedMatches.Count > 1)
            {
                error = "error: ambiguous preview element type match";
                return null;
            }

            if (typedMatches.Count == 1)
            {
                targetElement = typedMatches[0];
            }
        }

        if (targetElement is null)
        {
            error = "error: no preview element matched query";
        }

        return targetElement;
    }

    private static FrameworkElement? FindNearestFrameworkElement(DependencyObject start)
    {
        var current = start;
        while (current is not null)
        {
            if (current is FrameworkElement frameworkElement)
            {
                return frameworkElement;
            }

            DependencyObject? visualParent = null;
            if (current is Visual || current is Visual3D)
            {
                visualParent = VisualTreeHelper.GetParent(current);
            }

            current = visualParent ?? LogicalTreeHelper.GetParent(current) as DependencyObject;
        }

        return null;
    }

    private static Rect GetBoundsInRoot(FrameworkElement element, FrameworkElement root)
    {
        element.UpdateLayout();
        var width = Math.Max(1, element.ActualWidth);
        var height = Math.Max(1, element.ActualHeight);

        try
        {
            var transform = element.TransformToAncestor(root);
            var origin = transform.Transform(new Point(0, 0));
            return new Rect(origin.X, origin.Y, width, height);
        }
        catch
        {
            return new Rect(0, 0, width, height);
        }
    }

    private static IEnumerable<FrameworkElement> EnumerateFrameworkElementCandidates(FrameworkElement root)
    {
        yield return root;

        foreach (var descendant in EnumerateDescendants(root).OfType<FrameworkElement>())
        {
            yield return descendant;
        }
    }

    private static void ParseFindQuery(string? query, out string requestedName, out string requestedType)
    {
        requestedName = string.Empty;
        requestedType = string.Empty;

        if (string.IsNullOrWhiteSpace(query))
        {
            return;
        }

        var entries = query.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (var entry in entries)
        {
            var index = entry.IndexOf('=');
            if (index <= 0 || index >= entry.Length - 1)
            {
                continue;
            }

            var key = entry.Substring(0, index).Trim();
            var value = Uri.UnescapeDataString(entry.Substring(index + 1)).Trim();
            if (string.Equals(key, "name", StringComparison.OrdinalIgnoreCase))
            {
                requestedName = value;
            }
            else if (string.Equals(key, "type", StringComparison.OrdinalIgnoreCase))
            {
                requestedType = value;
            }
        }
    }

    private static string? DescribeBrushColor(Control? control)
    {
        return control?.Background switch
        {
            SolidColorBrush solidColorBrush => solidColorBrush.Color.ToString(),
            null => null,
            var brush => brush.ToString(),
        };
    }

    private static string DescribeElementText(FrameworkElement element)
    {
        return element switch
        {
            TextBox textBox => textBox.Text ?? string.Empty,
            TextBlock textBlock => textBlock.Text ?? string.Empty,
            HeaderedContentControl headeredContentControl => headeredContentControl.Header?.ToString() ?? string.Empty,
            ContentControl contentControl => contentControl.Content?.ToString() ?? string.Empty,
            _ => string.Empty,
        };
    }

    private static string DescribeElementBackground(FrameworkElement element)
    {
        if (element is Control control)
        {
            return DescribeBrush(control.Background);
        }

        if (element is Panel panel)
        {
            return DescribeBrush(panel.Background);
        }

        return string.Empty;
    }

    private static string DescribeElementForeground(FrameworkElement element)
    {
        if (element is Control control)
        {
            return DescribeBrush(control.Foreground);
        }

        if (element is TextBlock textBlock)
        {
            return DescribeBrush(textBlock.Foreground);
        }

        return string.Empty;
    }

    private static string DescribeBrush(Brush? brush)
    {
        return brush switch
        {
            SolidColorBrush solidColorBrush => solidColorBrush.Color.ToString(),
            null => string.Empty,
            _ => brush.ToString() ?? string.Empty,
        };
    }

    private static string DescribeSizeValue(double value)
    {
        return double.IsNaN(value)
            ? "Auto"
            : value.ToString("0.##", CultureInfo.InvariantCulture);
    }

    private static string DescribeThickness(Thickness thickness)
    {
        return string.Format(
            CultureInfo.InvariantCulture,
            "{0:0.##},{1:0.##},{2:0.##},{3:0.##}",
            thickness.Left,
            thickness.Top,
            thickness.Right,
            thickness.Bottom);
    }

    private static bool SupportsTextEdit(FrameworkElement element)
    {
        return element is TextBox
            || element is TextBlock
            || element is HeaderedContentControl
            || element is ContentControl;
    }

    private static bool SupportsBackgroundEdit(FrameworkElement element)
    {
        return element is Control
            || element is Panel
            || element is Border
            || element is Window;
    }

    private static bool SupportsForegroundEdit(FrameworkElement element)
    {
        return element is Control
            || element is TextBlock;
    }

    private static string? DescribeSelectorIndex(Selector? selector)
    {
        return selector?.SelectedIndex.ToString();
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

    private static object? FindNamedElement(DependencyObject? root, string name)
    {
        if (root is null)
        {
            return null;
        }

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

    private static object ParseXamlIgnoringEventMembers(string xamlText)
    {
        using var textReader = new StringReader(xamlText);
        using var xmlReader = XmlReader.Create(textReader, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
        });

        using var xamlReader = new XamlXmlReader(xmlReader);
        var objectWriter = new XamlObjectWriter(xamlReader.SchemaContext);

        while (xamlReader.Read())
        {
            if (xamlReader.NodeType == XamlNodeType.StartMember &&
                xamlReader.Member?.IsEvent == true)
            {
                xamlReader.Skip();
                continue;
            }

            objectWriter.WriteNode(xamlReader);
        }

        return objectWriter.Result
            ?? throw new InvalidOperationException("XAML parse produced no root object.");
    }

    private static bool TryApplyNamedElementPropertyUpdates(string xamlText, out string message)
    {
        message = "xml fallback did not find applicable named property updates";
        try
        {
            var app = Application.Current;
            var mainWindow = app?.MainWindow;
            if (mainWindow is null)
            {
                message = "xml fallback requires an active MainWindow";
                return false;
            }

            var document = XDocument.Parse(xamlText, LoadOptions.None);
            var xNamespace = (XNamespace)"http://schemas.microsoft.com/winfx/2006/xaml";
            var updatedProperties = 0;
            var updatedElements = 0;

            if (document.Root is null)
            {
                message = "xml fallback could not find a XAML root element";
                return false;
            }

            foreach (var element in document.Root.DescendantsAndSelf())
            {
                var elementName = (string?)element.Attribute(xNamespace + "Name");
                if (string.IsNullOrWhiteSpace(elementName))
                {
                    continue;
                }

                var liveElement = FindNamedElement(mainWindow, elementName!);
                if (liveElement is null)
                {
                    continue;
                }

                var perElementUpdates = 0;
                foreach (var attribute in element.Attributes())
                {
                    if (!ShouldTryApplyAttribute(attribute))
                    {
                        continue;
                    }

                    if (TryApplyPropertyValue(liveElement, attribute.Name.LocalName, attribute.Value))
                    {
                        perElementUpdates++;
                    }
                }

                if (perElementUpdates > 0)
                {
                    updatedProperties += perElementUpdates;
                    updatedElements++;
                }
            }

            if (updatedProperties == 0)
            {
                message = "xml fallback found no matching named properties to update";
                return false;
            }

            message = $"xml fallback updated {updatedProperties} property value(s) across {updatedElements} element(s)";
            return true;
        }
        catch (Exception ex)
        {
            message = $"xml fallback failed: {ex.GetType().Name}: {ex.Message}";
            return false;
        }
    }

    private static bool ShouldTryApplyAttribute(XAttribute attribute)
    {
        if (attribute.IsNamespaceDeclaration)
        {
            return false;
        }

        if (attribute.Name.NamespaceName == "http://schemas.microsoft.com/winfx/2006/xaml")
        {
            return false;
        }

        if (attribute.Name.NamespaceName == "http://schemas.openxmlformats.org/markup-compatibility/2006")
        {
            return false;
        }

        if (attribute.Name.NamespaceName == "http://schemas.microsoft.com/expression/blend/2008")
        {
            return false;
        }

        // Attached properties (Grid.Row, etc.) are skipped in this fallback path.
        if (attribute.Name.LocalName.Contains('.'))
        {
            return false;
        }

        return true;
    }

    private static bool TryApplyPropertyValue(object target, string propertyName, string rawValue)
    {
        var property = target.GetType().GetProperty(propertyName);
        if (property is null || !property.CanWrite)
        {
            return false;
        }

        try
        {
            object? convertedValue;
            if (property.PropertyType == typeof(string))
            {
                convertedValue = rawValue;
            }
            else
            {
                var converter = TypeDescriptor.GetConverter(property.PropertyType);
                if (converter is null || !converter.CanConvertFrom(typeof(string)))
                {
                    return false;
                }

                convertedValue = converter.ConvertFrom(
                    context: null,
                    culture: CultureInfo.InvariantCulture,
                    value: rawValue);
            }

            property.SetValue(target, convertedValue);
            return true;
        }
        catch
        {
            return false;
        }
    }
}

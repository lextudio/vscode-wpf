# x:Code Support in WXSG and Language Server

## Overview

`x:Code` is a XAML language intrinsic type that allows developers to write C# code directly inside XAML files. The content is compiled into the partial class that backs the XAML root element.

**Reference:** [x:Code Intrinsic XAML Type (Microsoft Docs)](https://learn.microsoft.com/en-us/dotnet/desktop/xaml-services/xcode-intrinsic-xaml-type)

## Syntax

```xaml
<Window x:Class="sample.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Sample Window">
  
  <!-- x:Code block contains C# statements that become part of the partial class -->
  <x:Code>
    <![CDATA[
    private int _counter = 0;
    
    private void OnButtonClick(object sender, RoutedEventArgs e) {
        _counter++;
        StatusText.Text = $"Clicked {_counter} times";
    }
    ]]>
  </x:Code>
  
  <StackPanel>
    <Button Click="OnButtonClick">Click Me</Button>
    <TextBlock x:Name="StatusText">Ready</TextBlock>
  </StackPanel>
</Window>
```

## Architecture

### XAML Parsing Pipeline

The processing flow is:

```
XAML File
  ↓
SimpleXamlDocumentParser (XML parse → XamlDocumentModel)
  ↓
IXamlDocumentEnricher (feature extraction)
  ├─ AvaloniaDocumentFeatureEnricher (Resources, Templates, Styles, Includes)
  └─ WpfDocumentFeatureEnricher (x:Code blocks) ← NEW
  ↓
IXamlSemanticBinder (Roslyn type binding & diagnostics)
  ↓
IXamlCodeEmitter (C# code generation)
  ├─ AvaloniaCodeEmitter
  └─ WpfCodeEmitter ← Updated to emit CodeBlocks
  ↓
Generated C# partial class
```

### Key Components

#### 1. **Model: `XamlCodeBlockDefinition`**

Located: `external/wxsg/external/XamlToCSharpGenerator/src/XamlToCSharpGenerator.Core/Models/XamlCodeBlockDefinition.cs`

```csharp
public sealed record XamlCodeBlockDefinition(
    string RawCode,
    int Line,
    int Column,
    ConditionalXamlExpression? Condition = null);
```

Stores the raw C# text content extracted from an `<x:Code>` element, along with source location and any conditional namespace metadata.

#### 2. **Document Model Update: `XamlDocumentModel`**

Located: `external/wxsg/external/XamlToCSharpGenerator/src/XamlToCSharpGenerator.Core/Models/XamlDocumentModel.cs`

Add field:
```csharp
ImmutableArray<XamlCodeBlockDefinition> CodeBlocks
```

Initialized to empty in `SimpleXamlDocumentParser.Parse()`, populated by the enricher.

#### 3. **Enricher: `WpfDocumentFeatureEnricher`** (NEW)

Located: `external/wxsg/src/XamlToCSharpGenerator.WPF/Parsing/WpfDocumentFeatureEnricher.cs`

Implements `IXamlDocumentEnricher`:

- Walks the XAML tree via `parseContext.RootElement.DescendantsAndSelf()`
- Recognizes elements with:
  - **LocalName**: `Code`
  - **NamespaceName**: `http://schemas.microsoft.com/winfx/2006/xaml`
- Extracts the text content (typically wrapped in `<![CDATA[...]]>`)
- Captures line/column information via `IXmlLineInfo`
- Handles conditional namespaces (for future `xamlCompiled:*` namespace support)
- Returns `document with { CodeBlocks = ... }`

#### 4. **Framework Profile: `WpfFrameworkProfile`**

Located: `external/wxsg/src/XamlToCSharpGenerator.WPF/Framework/WpfFrameworkProfile.cs`

Currently (line 79):
```csharp
public ImmutableArray<IXamlDocumentEnricher> CreateDocumentEnrichers()
{
    // WPF files carry no document enrichers
    return ImmutableArray<IXamlDocumentEnricher>.Empty;
}
```

Update to:
```csharp
public ImmutableArray<IXamlDocumentEnricher> CreateDocumentEnrichers()
{
    return ImmutableArray.Create<IXamlDocumentEnricher>(
        WpfDocumentFeatureEnricher.Instance);
}
```

#### 5. **Code Emission: `WpfCodeEmitter`**

Located: `external/wxsg/src/XamlToCSharpGenerator.WPF/Emission/WpfCodeEmitter.cs`

Update `Emit()` method to:
- After emitting named element field declarations
- Before the `InitializeComponent()` method
- Emit each `CodeBlock.RawCode` directly into the partial class body
- Only when `viewModel.Document.IsClassBacked == true` (code blocks only valid in class-backed XAML)

Example output:
```csharp
public partial class MainWindow : Window
{
    // Named element fields (existing)
    private TextBlock? StatusText;

    // x:Code blocks (NEW)
    private int _counter = 0;
    
    private void OnButtonClick(object sender, RoutedEventArgs e) {
        _counter++;
        StatusText.Text = $"Clicked {_counter} times";
    }

    public void InitializeComponent() {
        // ... existing InitializeComponent code
    }
}
```

#### 6. **Language Service: IDE Navigation & Completion**

Located: `external/wxsg/external/XamlToCSharpGenerator/src/XamlToCSharpGenerator.LanguageService/Definitions/XamlInlineCSharpNavigationService.cs`

Update `IsInlineCSharpElement()` method (around line 760) to recognize `x:Code`:

```csharp
if (element.Name.LocalName == "Code" && 
    element.Name.NamespaceName == "http://schemas.microsoft.com/winfx/2006/xaml")
{
    return new XamlInlineCSharpContext(
        Element: element,
        IsEventCode: true,  // Treat as statement block, not expression
        ...
    );
}
```

This enables:
- **IntelliSense**: Full C# completion inside `<x:Code>` blocks
- **Diagnostics**: Roslyn-based syntax checking and semantic analysis
- **Go-to-definition**: Navigate to types and members referenced in the block
- **Hover**: Type information and documentation

## Constraints & Validation

### Valid Only in Class-Backed XAML

`x:Code` blocks are only valid when:
- The root element has `x:Class="FullyQualifiedClassName"`
- The code is part of the generated partial class

**Diagnostic**: If an `x:Code` block appears without `x:Class`, emit:
```
WXSG00XX: x:Code requires x:Class-backed root element
```

### Content Structure

- Content is typically wrapped in `<![CDATA[...]]>` to avoid XML escaping
- Multiple `<x:Code>` blocks are supported and emitted in order
- Content is inserted verbatim (whitespace preserved)
- No injection or sanitization — trust XAML parser (content is static)

### Ordering in Generated Class

Generated class structure:
```
namespace { 
    public partial class ClassName {
        // 1. Named element field declarations
        // 2. x:Code blocks (in source order)
        // 3. InitializeComponent() method
        // 4. Other generated support methods
    }
}
```

## Testing

### Unit Tests

**Location**: `external/wxsg/external/XamlToCSharpGenerator/tests/XamlToCSharpGenerator.Tests/Generator/SimpleXamlDocumentParserTests.cs`

Test cases:
- ✅ Parse single `<x:Code>` block
- ✅ Parse multiple `<x:Code>` blocks in order
- ✅ Extract CDATA content correctly
- ✅ Capture line/column for diagnostics
- ✅ Ignore `x:Code` in class-less XAML (diagnostic)
- ✅ Handle empty `<x:Code>` blocks

### Integration Tests

**Location**: Add new test file or extend existing WPF code emitter tests

Test cases:
- ✅ Generate correct C# syntax for code blocks
- ✅ Preserve whitespace and formatting
- ✅ Order code blocks same as XAML source
- ✅ IDE navigation works (jump to definition, completion)
- ✅ Roslyn diagnostics are reported for C# errors in blocks

### Sample Project

**Location**: `sample/net6.0-csharp-expressions/`

Add `MainWindow.xaml` with `x:Code` example:
```xaml
<Window x:Class="sample.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="x:Code Demo" Width="400" Height="300">
  
  <x:Code>
    <![CDATA[
    private int _clickCount = 0;

    private void OnButtonClick(object sender, RoutedEventArgs e) {
        _clickCount++;
        CounterLabel.Content = $"Clicks: {_clickCount}";
    }
    ]]>
  </x:Code>

  <StackPanel Margin="20">
    <Button Click="OnButtonClick" Padding="10,5">Click Me</Button>
    <Label x:Name="CounterLabel" Margin="0,10,0,0">Clicks: 0</Label>
  </StackPanel>
</Window>
```

## Future Enhancements

1. **Conditional Compilation**: `xamlCompiled:Condition="..."` attribute support
2. **Code Block Validation**: Real-time Roslyn analysis of C# syntax
3. **Refactoring**: Support for rename/extract refactorings that touch `x:Code` content
4. **Source Maps**: Link generated code back to original XAML lines for debugging
5. **MAUI Support**: Extend to Avalonia/MAUI frameworks if needed

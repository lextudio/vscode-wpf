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

## Language Service Diagnostics

### Real-Time Error Reporting

The language server now provides real-time diagnostic support for x:Code blocks, including compilation errors from C# code embedded in XAML files.

### Diagnostic Reporting Flow

```
XAML File with x:Code
    ↓
[Parser] Extracts x:Code blocks
    ↓
[XamlDocumentModel.CodeBlocks] Stores code locations
    ↓
[WpfCodeEmitter] Generates C# with #line directives
    ↓
[Roslyn Compilation] Compiles full C# class
    ↓
[XamlCompilerAnalysisService.AddRoslynCompilationDiagnostics]
    Extracts errors and maps back to XAML positions
    ↓
[Language Service Engine] Returns diagnostics with
    correct line/column numbers in XAML file coordinates
```

### Source Mapping via #line Directives

The `WpfCodeEmitter` emits x:Code blocks with `#line` directives for source location mapping:

**Location**: `external/wxsg/src/XamlToCSharpGenerator.WPF/Emission/WpfCodeEmitter.cs` (lines 289-302)

```csharp
private static void EmitCodeBlocks(GraphEmitter emitter, XamlDocumentModel doc)
{
    var sb = emitter.Builder;
    var i = emitter.MemberIndent;

    foreach (var codeBlock in doc.CodeBlocks)
    {
        sb.AppendLine(i + "#line " + codeBlock.Line.ToString(CultureInfo.InvariantCulture));
        sb.Append(codeBlock.RawCode.TrimStart('\r', '\n'));
        sb.AppendLine();
        sb.AppendLine(i + "#line default");
        sb.AppendLine();
    }
}
```

This ensures that any Roslyn errors in the emitted code automatically map to the correct XAML line numbers.

### Language Service Support

All major language services are automatically available for x:Code blocks through the unified inline C# infrastructure:

#### 1. **Completions** ✅
**Service**: `XamlInlineCSharpCompletionService`  
**How it works**: 
- Detects x:Code elements via `XamlInlineCSharpNavigationService`
- Provides C# member completions for variables, methods, types
- Works for both implicit (context variables) and explicit receivers

#### 2. **Hover** ✅
**Service**: `XamlHoverService.TryGetInlineCSharpHover()`  
**How it works**:
- Resolves symbol at cursor position in x:Code
- Returns type information and symbol documentation

#### 3. **Go-to-Definition** ✅
**Service**: `XamlDefinitionService`  
**How it works**:
- Uses `XamlInlineCSharpNavigationService.TryResolveNavigationTarget()`
- Jumps to symbol declaration in code or external files

#### 4. **Find References** ✅
**Service**: `XamlReferenceService.GetReferences()`  
**How it works**:
- Finds all uses of a symbol across the project
- Returns x:Code locations where symbol is referenced

#### 5. **Semantic Tokens (Syntax Highlighting)** ✅
**Service**: `XamlSemanticTokenService`  
**How it works**:
- Enumerates all inline C# contexts including x:Code
- Provides token classifications: keyword, identifier, string, etc.
- Enables proper syntax coloring for code blocks

#### 6. **Rename/Refactoring** ✅
**Service**: `XamlRenameService`  
**How it works**:
- Refactors identifiers across x:Code blocks and XAML
- Roslyn renames handle code blocks automatically via generated C#

### Roslyn Diagnostic Extraction

**Location**: `external/wxsg/external/XamlToCSharpGenerator/src/XamlToCSharpGenerator.LanguageService/Analysis/XamlCompilerAnalysisService.cs`

When `IncludeSemanticDiagnostics` is enabled, the analysis service extracts Roslyn compilation errors:

```csharp
private static void AddRoslynCompilationDiagnostics(
    ImmutableArray<LanguageServiceDiagnostic>.Builder diagnostics,
    Compilation? compilation)
{
    if (compilation is null) return;

    try
    {
        var roslynDiagnostics = compilation.GetDiagnostics();
        foreach (var diagnostic in roslynDiagnostics)
        {
            if (diagnostic.Severity != DiagnosticSeverity.Error) continue;
            if (diagnostic.Location == Location.None) continue;

            var lineSpan = diagnostic.Location.GetLineSpan();
            var lsDiagnostic = new LanguageServiceDiagnostic(
                Code: diagnostic.Id,
                Message: diagnostic.GetMessage(),
                Severity: LanguageServiceDiagnosticSeverity.Error,
                Range: new SourceRange(
                    Start: new SourcePosition(lineSpan.StartLinePosition.Line, lineSpan.StartLinePosition.Character),
                    End: new SourcePosition(lineSpan.EndLinePosition.Line, lineSpan.EndLinePosition.Character)),
                Source: "Roslyn");

            diagnostics.Add(lsDiagnostic);
        }
    }
    catch (Exception ex)
    {
        System.Diagnostics.Debug.WriteLine($"Failed to extract Roslyn diagnostics: {ex.Message}");
    }
}
```

### Example: Error Detection

Given this XAML with x:Code:

```xaml
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        x:Class="MyApp.MainWindow">
  
  <x:Code>
    <![CDATA[
    private void OnClick()
    {
        UndefinedMethod();  // Line 8: Error reported here
    }
    ]]>
  </x:Code>
  
</Window>
```

**Error Reported**:
```
[Roslyn] CS1061: 'MainWindow' does not contain a definition for 'UndefinedMethod'
  Location: Line 8, Column 9
  Severity: Error
```

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

## Complete Language Service Coverage

### Architecture Overview

x:Code blocks are seamlessly integrated into the language server through a unified architecture:

```
x:Code Element in XAML
    ↓
[XamlInlineCSharpNavigationService.IsInlineCSharpElement]
    Recognizes x:Code with: localName="Code", namespace="http://schemas.microsoft.com/winfx/2006/xaml"
    ↓
[XamlInlineCSharpNavigationService.EnumerateContexts & TryResolveElementContentContext]
    Extracts: raw C# code, line/column positions, scope element
    ↓
[All Language Services]
    Use the context infrastructure to provide:
    • Completions (XamlInlineCSharpCompletionService)
    • Hover (XamlHoverService.TryGetInlineCSharpHover)
    • Definitions (XamlDefinitionService + TryResolveNavigationTarget)
    • References (XamlReferenceService.GetReferences)
    • Semantic Tokens (XamlSemanticTokenService.EnumerateContexts)
    • Rename (XamlRenameService via Roslyn rename)
```

### Service Integration Points

| Service | Entry Point | x:Code Support |
|---------|------------|-----------------|
| **Completions** | `XamlCompletionService.GetCompletions()` line 38 | ✅ `XamlInlineCSharpCompletionService.TryGetCompletions()` |
| **Hover** | `XamlHoverService.GetHover()` line 22 | ✅ `TryGetInlineCSharpHover()` |
| **Definitions** | `XamlDefinitionService.GetDefinitions()` line 26 | ✅ `XamlInlineCSharpNavigationService.TryResolveNavigationTarget()` |
| **References** | `XamlReferenceService.GetReferences()` line 129 | ✅ Handled via navigation service |
| **Semantic Tokens** | `XamlSemanticTokenService.GetTokens()` line 54 | ✅ `XamlInlineCSharpNavigationService.EnumerateContexts()` |
| **Rename** | `XamlRenameService.RenameAsync()` line 146 | ✅ `TryResolveRoslynRenameTargetAsync()` uses Roslyn rename |

### What Each Service Provides for x:Code

1. **Completions**: Type-aware suggestions while typing
   - Member completions for class fields/methods
   - Local variable completions in scope
   - Lambda parameter suggestions

2. **Hover**: Symbol documentation and type information
   - Method signatures
   - Property types
   - XML documentation comments

3. **Go-to-Definition**: Jump to declaration
   - Navigate to class members
   - Open external type definitions
   - Jump to using/namespace declarations

4. **Find References**: Locate all usages
   - Find where a field/method is used
   - Cross-reference x:Code blocks
   - Integrate with XAML attribute references

5. **Semantic Tokens**: Syntax highlighting
   - Keywords (private, void, if, etc.)
   - Identifiers (variable/method names)
   - Strings and numbers
   - Proper coloring for readability

6. **Rename Refactoring**: Safe identifier renaming
   - Rename field/method across all x:Code blocks
   - Update XAML references automatically
   - Preserve compiled code validity

## Future Enhancements

1. **Conditional Compilation**: `xamlCompiled:Condition="..."` attribute support
2. **Code Block Validation**: Real-time Roslyn analysis of C# syntax
3. **Extract Method**: Refactoring to extract code into separate methods
4. **Code Snippets**: Provide code templates for common patterns
5. **MAUI Support**: Extend to Avalonia/MAUI frameworks if needed

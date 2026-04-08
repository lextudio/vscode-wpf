# VB Expressions in XAML for XSG/WPF

> Status: Proposal v0.1

## Summary

This document proposes an experimental VB-friendly expression feature for XAML in the XSG for WPF toolchain.

The proposal is inspired by the architecture behind Microsoft MAUI's XAML C# expressions, but it is not a surface-level port of that feature. The important idea to borrow is the split between a language-aware expression front end and a shared lowering pipeline. The important idea not to borrow blindly is the exact C#-centric surface syntax and resolution rules.

For WPF and VB.NET, the design should be explicit, tooling-first, and WPF-native in its lowering strategy. In practice, that means:

- explicit host syntax instead of implicit `{ ... }` expression detection
- VB parsing and semantics, not pseudo-C# rules adapted after the fact
- lowering to standard WPF Binding, MultiBinding, PropertyPath, and generated event hookup where possible
- predictable binding-mode semantics instead of mixed "sometimes binding, sometimes captured value" behavior

The goal is to prove that expression-enabled XAML can be implemented in a way that respects both WPF and VB.NET, while still contributing something useful to the broader discussion around compile-time XAML tooling.

## Relationship to the MAUI Proposal

MAUI's XAML C# expressions are a valuable reference point, but they should be treated as an architectural precedent, not as a line-for-line template.

The MAUI proposal assumes a source-generation-centered pipeline and a typed binding story built around x:DataType-like information. That general direction is useful here. However, WPF does not have the same built-in compiled-binding surface, and standard WPF XAML still revolves around Binding, PropertyPath, ElementName, RelativeSource, converters, MultiBinding, and code-behind event handler names.

A good WPF/VB specification should therefore borrow these parts from the MAUI direction:

- language-aware parsing
- compile-time symbol resolution
- shared semantic lowering
- generated artifacts with traceable diagnostics

And it should avoid copying these parts directly:

- implicit expression mode inside ordinary `{ ... }` attributes
- C#-specific disambiguation syntax such as `this.` and `.Foo`
- C#-specific operator aliases
- event lambda syntax as a first-phase requirement
- assumptions that every expression should map to the same resolution precedence used by the MAUI prototype

## Current MAUI Design Inputs

At the time of writing, the public MAUI proposal uses direct `{...}` expressions in attribute values, explicit `{= ...}` disambiguation, `this.` and `.Foo` source qualifiers, word-based operator aliases such as `AND` and `LT`, CDATA guidance for complex expressions, and lambda-based event handling. It also states that simple property paths can remain two-way while complex expressions are one-way, and it lists the feature as SourceGen-only rather than something available through the existing XamlC or runtime inflation paths.

Those details matter for WPF and VB.NET. They explain why this proposal chooses an explicit XSG-owned host syntax, explicit source roots instead of `this.` and `.Foo`, VB-native operators instead of C# aliases, object-element syntax for event bindings, and WPF-native lowering through `Binding`, `MultiBinding`, `PropertyPath`, and generated hookup code rather than a mostly direct surface port.

## Motivation

Recent XAML tooling work has shown that source generation can move more semantic information into compile time and design time. That shift improves diagnostics, editor support, preview infrastructure, and the overall authoring experience.

Once expressions are introduced into XAML, an architectural question appears immediately:

> Is the feature a general XAML tooling capability, or is it a language-specific dialect coupled to one syntax?

The current MAUI proposal demonstrates that the problem can be treated as a tooling problem rather than a runtime-only trick. That is the most valuable lesson for WPF. At the same time, the MAUI design also shows where language coupling becomes visible. Its host syntax, operator escape rules, member-resolution conventions, and event examples are overtly C#-shaped.

For VB.NET WPF developers, a useful answer is not "make VB look enough like C# to fit the same parser." A better answer is to let the XAML pipeline acknowledge that expression parsing is language-specific while lowering and tooling can still be shared.

## Goals

This proposal has six goals:

1. First, it validates that VB expressions in XAML are technically feasible in an XSG-driven WPF pipeline.
2. Second, it defines a concrete host syntax that is explicit and workable in WPF XAML, rather than leaving syntax ambiguity as an open problem.
3. Third, it lowers expressions to existing WPF runtime mechanisms whenever possible, instead of requiring WPF runtime changes.
4. Fourth, it preserves understandable diagnostics, source mapping, and inspectable generated output.
5. Fifth, it improves the experience of VB.NET WPF developers without replacing existing Binding, converter, MultiBinding, or code-behind patterns.
6. Sixth, it contributes an architectural argument back to the broader XAML ecosystem: expression support should be modeled as language-aware parsing plus shared lowering, not as permanently C#-locked surface syntax.

## Non-goals

This proposal is intentionally limited.

- It does not attempt to redefine WPF itself.
- It does not attempt to standardize a cross-vendor XAML expression language.
- It does not attempt to make XAML a host for arbitrary VB code.
- It does not attempt to replicate every MAUI C# expression feature exactly.
- It does not attempt to support implicit expression detection in ordinary WPF markup-extension positions.
- It does not attempt, in phase 1, to support late binding, query expressions, XML literals, statement lambdas, async lambdas, anonymous types, or large embedded code snippets.
- It does not attempt, in phase 1, to solve every cross-project or mixed-language edge case.

## Design Principles

### 1. XAML remains primarily declarative

XAML should continue to describe UI structure, properties, styles, resources, templates, and event wiring. Expressions should remain narrow and purposeful. They are an additive authoring aid, not a license to move business logic into markup.

### 2. Host syntax and expression language are separate concerns

The text inside an expression should be valid VB syntax. The XAML surface that carries that text does not need to be raw VB syntax. WPF already has strong rules around markup extensions, attribute parsing, event hookup, and escaping. The proposal should respect those rules instead of pretending they do not exist.

### 3. Prefer WPF-native lowerings

If an expression can be represented as a standard Binding, PropertyPath, MultiBinding, converter-style computation, or generated AddHandler hookup, the feature should use that path. Phase 1 should minimize new runtime machinery.

### 4. Make source roots explicit

The feature should not rely on complex precedence between BindingContext-like members, page members, static types, and named elements. The source root should be explicit in the host model.

### 5. Diagnostics matter more than maximal language surface

A smaller feature with good diagnostics is better than a broader feature with unclear errors, unstable behavior, or opaque generated code.

### 6. Generated output must be inspectable

Developers should be able to understand what the toolchain generated and why. Generated partial classes, helper methods, converter types, and source maps should be stable enough to debug.

## XSG-Specific Data Context Typing

Because WPF does not have MAUI's built-in compiled-binding model, this proposal introduces an XSG-specific way to declare the current data source type for expression resolution.

The normative concept is an XSG data type declaration. In examples below, that declaration is written as `xsg:DataType`.

Example:

```xml
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:xsg="clr-namespace:Xsg.Markup"
        xmlns:vm="clr-namespace:MyApp.ViewModels"
        x:Class="MyApp.MainWindow"
        xsg:DataType="vm:MainViewModel">
```

A DataTemplate can override the active data type in its own scope:

```xml
<DataTemplate xsg:DataType="vm:OrderLineViewModel">
    ...
</DataTemplate>
```

Whether the final product uses `xsg:DataType` exactly, or aliases an existing XSG-specific metadata mechanism, is a concrete tooling choice. The important part is that the specification does not pretend standard WPF already has this concept.

## Host Syntax

Phase 1 should use explicit host syntax only.

There are two expression surfaces in this proposal: one for value expressions, and one for event bindings.

### Value expression syntax

Value expressions use an XSG-owned markup extension or object-element form.

Attribute form is intended for short expressions:

```xml
<TextBlock Text="{xsg:ExprVB 'Customer.Name'}" />
<TextBlock IsEnabled="{xsg:ExprVB 'Total > 0D'}" />
<TextBox Text="{xsg:ExprVB 'Customer.Name', Mode=TwoWay}" />
<TextBlock Text="{xsg:ExprVB 'WindowTitle', SourceRoot=Root}" />
<TextBlock Text="{xsg:ExprVB 'Text', ElementName=SearchBox}" />
```

In attribute form, the first positional argument is the VB expression text. It is single-quoted by the host syntax. Those single quotes are part of the XAML host syntax, not part of VB itself.

Object-element form is the canonical form for expressions that contain quotes, commas, right braces, or otherwise awkward attribute escaping:

```xml
<TextBlock.Text>
    <xsg:ExprVB SourceRoot="Data"><![CDATA[$"Hello {User.DisplayName}"]]></xsg:ExprVB>
</TextBlock.Text>

<TextBlock.Visibility>
    <xsg:ExprVB><![CDATA[If(ShowDetails, Visibility.Visible, Visibility.Collapsed)]]></xsg:ExprVB>
</TextBlock.Visibility>
```

Object-element form should be the documented recommendation for interpolated strings and other complex expressions.

### Event binding syntax

Phase 1 should not overload ordinary WPF event attributes such as `Click="Button_Click"`.

Instead, event expressions should use an XSG-owned object-element surface so that standard WPF event semantics remain untouched and backward-compatible.

Example:

```xml
<Button>
    <xsg:Events>
        <xsg:Event Name="Click" Handler="AddressOf OnSaveClicked" />
    </xsg:Events>
</Button>
```

This makes event expressions explicitly XSG-owned. The generator can strip or lower these nodes before the normal WPF loading path sees them.

### Why explicit syntax is required

This proposal intentionally rejects implicit `{ ... }` expression mode for WPF phase 1.

WPF already uses braces for markup extensions, and markup extension parsing has long-established rules around constructor arguments, property assignment, comma separation, escaping, and nesting. Standard WPF event attributes also already have a meaning: the value is the name of a handler method.

That means syntax such as these should not be phase 1 goals:

```xml
<TextBlock Text="{Customer.Name}" />
<Button Click="{AddressOf OnSaveClicked}" />
```

The former collides with markup extension territory. The latter collides with native WPF event attribute semantics.

An explicit XSG host syntax keeps the parsing model honest and keeps old XAML working unchanged.

## Source Roots

Every value expression is resolved against an explicit source root.

Phase 1 defines four source-root forms.

### 1. Data

This is the default. It uses the active `xsg:DataType` in scope.

Example:

```xml
<TextBlock Text="{xsg:ExprVB 'Customer.Name'}" />
```

### 2. Root

This resolves against the containing `x:Class` type.

Example:

```xml
<TextBlock Text="{xsg:ExprVB 'WindowTitle', SourceRoot=Root}" />
```

### 3. Self

This resolves against the target element instance.

Example:

```xml
<TextBlock ToolTip="{xsg:ExprVB 'Text', SourceRoot=Self}" />
```

### 4. Explicit source object

This resolves against an explicitly referenced source object, for example a named element.

Example:

```xml
<TextBlock Text="{xsg:ExprVB 'Text', ElementName=SearchBox}" />
```

The attribute host may later grow RelativeSource-style capabilities, but phase 1 does not require that.

## Lowering Model

The most important architectural choice in this proposal is the lowering model.

The system should not translate parsed VB syntax directly into ad hoc output. It should lower supported expressions into a shared semantic representation first, then choose one of a small number of WPF-oriented back ends.

The recommended lowering targets are:

### 1. PathBinding lowering

This lowering is used when an expression can be represented as a standard WPF Binding path.

Typical cases include:

- member access
- nested member access
- indexer access
- some attached or static property references when they can be normalized to WPF PropertyPath syntax

Examples:

```vb
Customer.Name
Orders(0).Total
Settings("Theme").DisplayName
```

The result is a generated Binding with a standard Path and a standard WPF source selection.

### 2. ComputedBinding lowering

This lowering is used when an expression depends on one or more observable inputs but cannot be represented as a single WPF Path.

Typical cases include:

- arithmetic
- boolean combinations
- comparisons
- If operator
- interpolated strings
- null-conditional chains that need computation semantics rather than a raw PropertyPath

Examples:

```vb
Price * Quantity
IsAdmin AndAlso Not IsLocked
If(ShowDetails, Visibility.Visible, Visibility.Collapsed)
$"{FirstName} {LastName}"
```

The recommended WPF back end for this case is generated MultiBinding plus a generated helper or IMultiValueConverter implementation.

This is a WPF-specific advantage. WPF already has a standard MultiBinding mechanism, so computed expressions do not need to invent an entirely separate runtime expression engine.

### 3. Direct assignment lowering

This lowering is used when the expression is fully static or otherwise does not need runtime re-evaluation through binding.

Typical cases include:

- enum or static values with no bindable inputs
- constant expressions
- other trivial cases where generated initialization code is simpler than binding

This should be used sparingly and predictably. The default mental model for value expressions should remain binding-oriented.

### 4. EventHook lowering

This lowering is used for XSG-owned event bindings. It generates normal event hookup code against the compiled `x:Class` partial type.

Example:

```xml
<xsg:Event Name="Click" Handler="AddressOf OnSaveClicked" />
```

This lowers to standard event subscription code during initialization.

## Expression Categories and Binding Modes

A key weakness in many expression designs is that they blur together these questions:

- what source the expression is evaluated against
- whether the expression is reactive
- whether the target is OneWay or TwoWay
- whether the expression has a setter projection

This proposal separates them explicitly.

### Path expressions

A path expression may use normal WPF binding mode semantics.

Examples:

```vb
Customer.Name
Order.Total
Settings("Theme").DisplayName
```

If the target property normally defaults to TwoWay and the path is writable, the generated Binding can participate in that mode. If the path is read-only, TwoWay is invalid but OneWay and OneTime remain valid.

### Computed expressions

Computed expressions are OneWay or OneTime only in phase 1.

Examples:

```vb
FirstName & " " & LastName
Price * Quantity
If(IsVip, "Gold", "Standard")
```

Phase 1 does not attempt to infer or synthesize ConvertBack logic for arbitrary computed expressions.

### Event expressions

Event expressions are not data bindings. They are generated event hookups and use their own lowering path.

## Supported VB Subset for Phase 1

Phase 1 should support a deliberately small but useful subset.

### Supported value-expression forms

- member access
- nested member access
- indexer access
- null-conditional access with `?.` and `?()`
- arithmetic operators
- comparison operators
- boolean operators, including `AndAlso`, `OrElse`, and `Not`
- the `If` operator in both its ternary and null-coalescing forms
- string interpolation
- simple enum and static member references
- simple explicit conversions when the resulting semantic model remains otherwise supported

### Supported event-expression forms

- `AddressOf` method references

Examples:

```xml
<TextBlock Text="{xsg:ExprVB 'Customer.Name'}" />
<TextBlock IsEnabled="{xsg:ExprVB 'Order.Total > 0D'}" />
<TextBlock IsEnabled="{xsg:ExprVB 'IsAdmin AndAlso Not IsLocked'}" />
<TextBlock Text="{xsg:ExprVB 'If(DisplayName, ""Unknown"")'}" />

<TextBlock.Text>
    <xsg:ExprVB><![CDATA[$"Hello {User.DisplayName}"]]></xsg:ExprVB>
</TextBlock.Text>
```

```xml
<Button>
    <xsg:Events>
        <xsg:Event Name="Click" Handler="AddressOf OnSaveClicked" />
    </xsg:Events>
</Button>
```

### Explicitly unsupported in phase 1

- late binding
- query expressions
- XML literals and XML axis properties
- lambdas in value expressions
- statement lambdas
- async lambdas
- Await expressions
- anonymous types
- object or collection initializers
- large embedded snippets that undermine readability

Several of these are not impossible forever. They are excluded because they greatly increase ambiguity, host-syntax pressure, debugging cost, and semantic complexity for the first usable implementation.

## VB Semantic Rules

### Option Strict

Phase 1 expressions should be resolved as strongly typed expressions. Any expression that requires late binding should produce a diagnostic.

In other words, expression sites behave as if the feature requires `Option Strict On` semantics for expression binding and lowering, even if the broader project allows looser semantics elsewhere.

This restriction is deliberate. A compile-time XAML feature should not depend on late-bound member discovery.

### Option Compare

String comparisons and `Like` semantics should follow the project's effective VB comparison rules. The generator should not silently replace VB string-comparison behavior with hardcoded ordinal rules.

This matters because in VB the meaning of string equality and ordering depends on `Option Compare`.

### Imports and compilation context

Expression binding should use the containing VB compilation context for symbol resolution, including normal imports and namespace lookup rules.

### Nothing and null-conditional semantics

`Nothing`, `?.`, and `?()` should keep standard VB meaning. The lowering layer may choose Binding, MultiBinding, or direct code generation, but it should preserve observable VB semantics rather than inventing special null rules for XAML.

### String literals and interpolation

VB string literals use double quotes, and interpolated strings use the same quoting model. That makes attribute-form XAML awkward for quoted VB expressions.

For that reason, object-element plus CDATA should be the preferred documented form for interpolated strings and any expression containing quotes. Attribute form remains useful for short quote-free expressions.

### Comments

Single-quote comments should not be supported in attribute form. They conflict with the host quoting model. Object-element form may choose to allow or forbid comments; phase 1 can keep the rule simple and forbid comments in both forms if that reduces parser edge cases.

## Why method calls are not a phase 1 centerpiece

The earlier draft treated simple method invocation as a natural phase 1 feature. This proposal intentionally steps back from that.

Arbitrary method calls inside reactive value expressions are much more expensive than they appear. They raise questions about purity, repeatability, side effects, ConvertBack, and source invalidation. A binding engine or converter may reevaluate them many times.

If method calls are eventually added, they should come after the path-binding and computed-binding foundations are stable. Phase 1 should not depend on them.

This still leaves a good event story through `AddressOf`, which is more idiomatic for VB and much closer to WPF's existing mental model for event hookup.

## Diagnostics Expectations

A serious expression feature lives or dies by diagnostics. Phase 1 should define clear diagnostic categories.

Recommended diagnostics include:

- `XSGVB1001` Invalid VB syntax in expression text.
- `XSGVB1002` Unsupported VB feature in phase 1.
- `XSGVB1003` SourceRoot=Data used without an active xsg:DataType in scope.
- `XSGVB1004` Member not found on the resolved source type.
- `XSGVB1005` Expression requires late binding and is therefore unsupported.
- `XSGVB1006` Expression cannot be lowered to the requested binding mode.
- `XSGVB1007` Event handler method not found or incompatible with the event delegate.
- `XSGVB1008` Attribute form requires escaping that makes the expression unreadable; prefer object-element form.
- `XSGVB1009` Computed expression requested as TwoWay; phase 1 supports OneWay or OneTime only.
- `XSGVB1010` ElementName or explicit source cannot be resolved.

Diagnostics should point to the XAML site first, then to the generated output when additional detail is needed.

## Compatibility Strategy

This proposal must coexist with ordinary WPF authoring.

That means:

- ordinary Binding syntax keeps working unchanged
- converters keep working unchanged
- MultiBinding keeps working unchanged
- ElementName, Source, and RelativeSource keep working unchanged
- ordinary `Click="Button_Click"` event attributes keep working unchanged
- code-behind remains a valid and often preferable option

VB expressions in XAML are optional. They should be additive, not disruptive.

A project should be able to adopt them gradually. If an expression site cannot be interpreted safely, the toolchain should fail with a clear build-time diagnostic rather than silently changing semantics.

## Why this differs from the current draft

The previous draft already had the right instinct on architecture: language-aware parsing plus shared lowering.

The main refinements in this version are:

1. First, the syntax is no longer left mostly open. WPF needs an explicit host model.
2. Second, the design no longer assumes MAUI-style context typing without defining a WPF equivalent.
3. Third, property expressions and event expressions are no longer forced through the same host syntax.
4. Fourth, phase 1 is narrowed around features that map well to WPF Binding and MultiBinding.
5. Fifth, the proposal now states explicit rules for Option Strict, Option Compare, binding modes, and source roots.

These changes make the spec less slogan-driven and more implementation-ready.

## Suggested Implementation Plan

### Milestone 1: host syntax and scope metadata

Define `xsg:DataType`, `xsg:ExprVB`, and `xsg:Events` surface syntax. Validate that XSG can identify these sites and map them back to exact XAML source locations.

### Milestone 2: VB parsing and semantic classification

Parse expression text with the VB front end and classify expressions into path-binding, computed-binding, direct-assignment, or event-hook categories.

### Milestone 3: PathBinding lowering

Generate standard WPF Binding output for member paths, nested paths, and indexers. Validate binding-mode behavior and diagnostics for writable versus read-only paths.

### Milestone 4: ComputedBinding lowering

Generate MultiBinding plus helper/converter output for arithmetic, comparison, boolean, If, and interpolation scenarios.

### Milestone 5: event binding

Generate event hookup for `AddressOf` handler references through the XSG-owned event surface.

### Milestone 6: diagnostics and source maps

Add build diagnostics, generated-file traceability, and editor mapping support.

### Milestone 7: experimental release

Ship behind an experimental flag, collect feedback, and expand only after the core mental model is stable.

## Success Criteria

This proposal should be considered successful if it demonstrates the following:

- A useful subset of VB expressions can be authored in XAML through an explicit, workable WPF host syntax.
- The XSG pipeline can parse them with VB semantics, classify them correctly, lower them to ordinary WPF mechanisms, and report understandable diagnostics.
- The feature remains additive and does not degrade ordinary WPF XAML authoring.
- Most importantly, the experiment demonstrates that expression-enabled XAML can be treated as a structured tooling problem instead of as a permanently C#-specific dialect.

## Open Questions

Several decisions are still open.

- Should `xsg:DataType` remain an XSG-owned concept, or should XSG also recognize an alias used elsewhere in the toolchain?
- Should phase 1 include RelativeSource and ancestor lookup, or wait until the basic root model is proven?
- Should simple intrinsic conversion functions be part of the supported phase 1 subset, or deferred with other method-like constructs?
- Should comments be allowed in object-element expressions, or forbidden everywhere in phase 1 for consistency?
- What is the best generated shape for computed bindings: generated converter classes, generated helper methods, or a hybrid?
- How should debugging and inspection of generated MultiBinding logic be surfaced to users in the IDE?

## Conclusion

VB expressions in XAML are not best understood as a request to copy a C# feature into a legacy corner.

They are better understood as a test of a broader architectural claim.

If expressions belong in XAML at all, then the pipeline should make language-specific parsing explicit, keep source roots and lowering rules honest, and target the native mechanisms of the platform it is extending.

For WPF, that means explicit host syntax, explicit data-type metadata, WPF-native lowerings, and VB semantics that are actually VB semantics.

That is a more realistic and more defensible design than a direct surface port of the MAUI C# proposal.

## Background References

This proposal was refined against:

- the current public MAUI XAML C# Expressions proposal
- the .NET MAUI compiled binding documentation
- WPF documentation for markup extensions
- WPF documentation for binding declarations
- WPF documentation for `PropertyPath`
- WPF documentation for events
- Visual Basic documentation for interpolated strings
- Visual Basic documentation for null-conditional operators
- Visual Basic documentation for `AddressOf`
- Visual Basic documentation for `Option Strict`
- Visual Basic documentation for `Option Compare`
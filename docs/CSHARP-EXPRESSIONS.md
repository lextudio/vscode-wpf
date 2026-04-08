# C# Expressions in XAML for XSG/WPF

> Status: Proposal v0.1

## Summary

This document proposes an experimental C# expression feature for XAML in the XSG for WPF toolchain.

The design is informed by Microsoft MAUI's XAML C# Expressions work, but it is intentionally not a line for line port. The useful lesson from MAUI is architectural: a language-aware parser can feed a shared lowering pipeline and produce compile-time diagnostics. The parts that should not be copied mechanically are the brace-based surface syntax, the implicit resolution precedence, the event lambda surface, and the mixed semantics where the same text can become either a live binding or a one-time captured value depending on context.

For WPF, a good design should be explicit, WPF-native, and conservative about semantics. In practical terms, that means:

- no reinterpretation of ordinary `{ ... }` attribute values
- no change to normal WPF event attribute syntax
- no guessing between DataContext members, root members, and static types
- no silent fallback from live binding to one-time evaluation
- no pseudo-C# quoting rules or operator aliases in the language itself
- lowering through standard WPF `Binding`, `MultiBinding`, `TemplateBinding`, `RelativeSource`, and generated helper code where possible
- source-mapped diagnostics that point back to XAML rather than only to generated C#

This proposal is therefore a WPF proposal first, and a response to the MAUI experiment second.

## Relationship to the MAUI Proposal

The current public MAUI proposal allows direct C# expressions inside ordinary `{...}` values, uses `{= ...}` to force expression parsing when a markup extension would otherwise win, uses `this.` and `.Foo` to disambiguate page members from binding-context members, defines word-based operator aliases such as `AND` and `LT` to work around XML escaping, allows lambda-based event handlers, and describes a model where simple paths may stay two-way while more complex expressions become one-way. The proposal also describes the feature as SourceGen-only.

That work is valuable for two reasons.

First, it shows that expression-enabled XAML can be approached as a compile-time tooling problem rather than a purely runtime feature.

Second, the early implementation history has already exposed several edge cases that matter for WPF design. Public follow-up issues in MAUI include source and target type mismatches in generated expression bindings, incorrect treatment of read-only properties under binding mode, and ambiguous resolution between instance members and static types. Those are not reasons to reject the idea. They are reasons to tighten the WPF proposal before the first implementation is attempted.

### Where MAUI is a good precedent

MAUI is a good precedent for these ideas:

- language-aware parsing
- semantic analysis against real Roslyn symbols
- generated artifacts instead of runtime reflection tricks
- compile-time diagnostics for invalid members and invalid expressions
- explicit acknowledgement that authoring ergonomics and generated-code quality both matter

### Where MAUI should not be copied directly for WPF

MAUI should not be copied directly in these areas:

- raw `{...}` expression mode
- page versus binding-context precedence rules
- fallback from expression binding to captured local evaluation
- lambda event syntax as a phase 1 requirement
- pseudo-language features such as operator aliases and single-quote string rewriting
- assumptions that the same surface can serve both mobile-first MAUI conventions and WPF's older, denser XAML ecosystem without tradeoffs

## Design Notes from Reviewing the MAUI Proposal

This section records the main design conclusions that came out of reviewing the MAUI proposal and its current implementation history.

### 1. Ordinary brace syntax is already taken in WPF

In WPF, `{...}` is not free syntax. It already means markup extension syntax. `Binding`, `StaticResource`, `DynamicResource`, `TemplateBinding`, `RelativeSource`, `x:Static`, `x:Type`, and custom markup extensions all rely on the rule that an attribute beginning with `{` enters markup-extension parsing. That is a core part of how WPF XAML is read and compiled.

A proposal that interprets ordinary `{Customer.Name}` as an expression when it does not match a markup extension sounds convenient, but in WPF it is the wrong place to add novelty. It collides with established parser behavior, custom markup extensions, and years of author expectations.

The MAUI answer is to prefer markup extensions first and then interpret the remaining cases as expressions, with `{= ...}` as an escape hatch. That is reasonable inside MAUI's experiment. It is still too magical for WPF.

The WPF proposal should therefore use an explicit XSG-owned host surface, not implicit expression detection in ordinary brace syntax.

### 2. WPF event attributes already have a fixed meaning

In WPF XAML, an event attribute such as `Click="OnClick"` already has a well-defined meaning: the value is the name of a handler method with the correct delegate signature. That is not just a convention. It is the documented WPF XAML event model.

Because of that, MAUI-style event lambda syntax is not a drop-in fit for WPF. Supporting inline lambdas would require either overriding normal WPF event attribute semantics or introducing an explicit parallel XSG event surface. Neither should be smuggled into phase 1.

There is also a practical point here. WPF already has a strong commanding model. In many modern WPF codebases, inline event lambdas are less compelling than they are in MAUI because command binding already covers the most common UI actions.

This proposal therefore defers inline event lambdas entirely.

### 3. Resolution precedence should be simpler, not smarter

MAUI currently explores precedence between markup extensions, binding-context members, local members, and static members, with explicit disambiguators such as `this.` and `.Foo`. That is workable, but it creates a large surface for surprising resolution decisions.

The public MAUI issue history already shows one example: instance-member access such as `Event.Notes` can be incorrectly pulled toward static-type resolution when a type and a property share the same name. That is exactly the kind of ambiguity WPF should avoid on day one.

For WPF, the resolution model should be much simpler:

- unqualified identifiers mean only the current data source
- `root`, `self`, `named`, and `templateParent` are explicit source roots
- static member access must be explicitly qualified
- there is no fallback chain from data to root to static

This is less magical and easier to diagnose.

### 4. Silent one-time capture is a footgun

The MAUI proposal allows some expressions to lower as live bindings and others to become one-time captured values when they cannot be represented as bindings. That makes the surface attractive, but it also makes it easy for an author to write something that looks dynamic and discover later that it was evaluated only once.

That ambiguity is especially risky in WPF, where authors already reason about `Binding`, `Mode`, `UpdateSourceTrigger`, `ElementName`, `RelativeSource`, `TemplateBinding`, and property-change notifications.

This proposal therefore rejects silent capture. If an expression is not live-observable, it must either be rejected or explicitly marked `Evaluation="Once"`.

### 5. Pseudo-C# should be avoided

One of the awkward parts of the MAUI proposal is that the expression text is not always ordinary C#. Word-based operator aliases and single-quote string rewriting are practical escape hatches for XML, but they also create a dialect.

For WPF C#, this proposal keeps the language text as normal C#.

That leads to a straightforward rule:

- attribute form is only a convenience for short, simple cases
- object-element form with CDATA is the canonical form for real expressions

This is more honest and easier to teach.

### 6. WPF has different source and template mechanics

WPF relies heavily on `ElementName`, `RelativeSource`, `TemplateBinding`, and `PropertyPath`. It also has an important constraint around `x:Reference`: XAML 2009 features such as `x:Reference` are not available in WPF markup-compiled XAML and BAML.

That means a WPF expression proposal should align with `ElementName` and `RelativeSource`, not treat `x:Reference` as a normal primitive.

It also means template scenarios deserve first-class treatment. A pure path against the templated parent should lower to `TemplateBinding` when it is semantically equivalent. That is more WPF-native than always generating a general binding.

### 7. Diagnostics must be a phase 1 feature, not a future nice-to-have

The MAUI source-generator work has already produced follow-up discussion about making diagnostics point to the XAML location instead of only to generated `.xsg.cs` files. WPF should not repeat that mistake.

An XSG/WPF implementation should treat source mapping, line pragmas, and stable diagnostic IDs as normative from the start.

## Goals

This proposal has six goals:

1. First, it defines a C# expression feature that fits WPF rather than competing with WPF's existing markup rules.
2. Second, it provides compile-time validation and typed authoring help for common XAML binding and computed-value scenarios.
3. Third, it lowers to existing WPF runtime mechanisms whenever possible, so that WPF itself does not need runtime changes.
4. Fourth, it makes semantics predictable. Authors should know when something is a live binding, when it is one-time evaluation, and when it is rejected.
5. Fifth, it preserves inspectable generated artifacts and high quality diagnostics.
6. Sixth, it gives XSG a design that can later be extended to other .NET languages without forcing those languages to imitate C#-specific surface quirks.

## Non-goals

This proposal is intentionally limited.

- It does not attempt to redefine WPF itself.
- It does not attempt to make all existing WPF bindings obsolete.
- It does not attempt to standardize a universal XAML expression language across all XAML frameworks.
- It does not attempt to make arbitrary code-behind logic comfortable inside XAML.
- It does not attempt to reinterpret ordinary `{...}` attribute values.
- It does not attempt, in phase 1, to support inline event lambdas, statement blocks, async code, query expressions, dynamic binding, or arbitrary method-call graphs in live expressions.
- It does not attempt, in phase 1, to support every imaginable template and name-scope edge case.
- It does not attempt to replace commands, converters, or view-model computed properties where those remain the clearer design.

## Design Principles

### 1. XAML remains primarily declarative

Expressions should be small and local. They are an authoring aid, not a replacement for view-model design.

### 2. Host syntax and language syntax are separate concerns

The expression text is C#. The XAML host surface that carries the text is not itself required to look like ordinary C#.

### 3. Prefer WPF-native lowerings

If something can lower cleanly to `Binding`, `MultiBinding`, `TemplateBinding`, `RelativeSource`, or `Binding.Source`, the proposal should prefer those mechanisms.

### 4. Make resolution explicit

A smaller, more explicit source model is better than a broader precedence chain.

### 5. Do not lie about liveness

If the generator cannot keep the expression live with normal WPF notification mechanisms, the author must say `Evaluation="Once"` or receive a diagnostic.

### 6. Generated output must be inspectable

Generated helper types, generated partial classes, and generated binding setup should be stable enough to debug and reason about.

### 7. Diagnostics are part of the feature

Error messages, warning messages, and source mapping are not secondary polish. They are part of the feature contract.

## XSG-Specific Typed Data Context

WPF does not have a built-in `x:DataType`-driven compiled-binding surface like MAUI. This proposal therefore introduces an XSG-specific typed data declaration.

The normative concept is an XSG data-type declaration. In examples below, it is written as `xsg:DataType`.

Example:

```xaml
<Window
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    xmlns:xsg="clr-namespace:Xsg.Markup"
    xmlns:vm="clr-namespace:MyApp.ViewModels"
    x:Class="MyApp.MainWindow"
    xsg:DataType="{x:Type vm:MainViewModel}">
```

A `DataTemplate` may override the active data type in its own scope:

```xaml
<DataTemplate xsg:DataType="{x:Type vm:OrderLineViewModel}">
    ...
</DataTemplate>
```

This is intentionally an XSG concept, not something the spec pretends already exists in standard WPF.

## High-Level Authoring Model

This proposal defines one XSG-owned value surface in phase 1: `xsg:Expr`.

`xsg:Expr` has two authoring forms.

The first is path form, intended for direct replacement of simple bindings with compile-time checking.

The second is code form, intended for computed expressions.

Both forms can appear either as a markup extension or as an object element, but the object-element form is the canonical form for any non-trivial expression.

Normal WPF surfaces remain valid and unchanged:

- `{Binding ...}` remains `{Binding ...}`
- `Click="OnClick"` remains the normal event syntax
- `TemplateBinding`, `StaticResource`, `DynamicResource`, and other markup extensions remain untouched

## Path Form

Path form is for expressions that are semantically just a source path.

Examples:

```xaml
<TextBlock Text="{xsg:Expr Path=Customer.Name}" />
<TextBox Text="{xsg:Expr Path=Customer.Name, Mode=TwoWay}" />
<TextBlock Text="{xsg:Expr Path=Title, SourceRoot=Root}" />
<TextBlock Text="{xsg:Expr Path=Text, ElementName=SearchBox}" />
<Rectangle Height="{xsg:Expr Path=ActualWidth, SourceRoot=Self}" />
```

This form exists because a large amount of real-world authoring is still just a path. It should remain concise.

## Code Form

Code form is for actual C# expressions.

Short expressions may appear in attribute form:

```xaml
<TextBlock Visibility="{xsg:Expr Code=IsBusy ? global::System.Windows.Visibility.Visible : global::System.Windows.Visibility.Collapsed}" />
```

However, object-element form is the canonical and recommended form:

```xaml
<TextBlock.Text>
    <xsg:Expr><![CDATA[$"{FirstName} {LastName}"]]></xsg:Expr>
</TextBlock.Text>

<TextBlock.Visibility>
    <xsg:Expr><![CDATA[IsBusy ? global::System.Windows.Visibility.Visible : global::System.Windows.Visibility.Collapsed]]></xsg:Expr>
</TextBlock.Visibility>
```

Object-element form should be the documented recommendation whenever the expression contains string literals, interpolation, casts, angle brackets, multiple logical operators, or any other syntax that would make attribute escaping noisy.

## Evaluation Mode

`xsg:Expr` has an explicit evaluation model.

The `Evaluation` property has these phase 1 values:

- `Live` (default)
- `Once`

`Live` means the generator must lower the expression through observable WPF mechanisms such as `Binding`, `MultiBinding`, `RelativeSource`, `TemplateBinding`, and generated helpers over those bindings.

`Once` means the expression is evaluated a single time during generated initialization logic, after the necessary object graph is available.

Example:

```xaml
<TextBlock.Text>
    <xsg:Expr Evaluation="Once"><![CDATA[global::System.DateTime.Now.ToString("D")]]></xsg:Expr>
</TextBlock.Text>
```

This proposal does not allow the generator to silently choose `Once` when the author asked for a live expression.

## Source Model and Name Resolution

The source model is deliberately smaller and more explicit than the one proposed in MAUI.

### Unqualified identifiers

In both path form and code form, an unqualified identifier is resolved only against the current data source described by `xsg:DataType`.

That means:

- `Customer.Name` means `data.Customer.Name`
- it does not mean `root.Customer.Name`
- it does not mean `self.Customer.Name`
- it does not mean a static type named `Customer`

If no active `xsg:DataType` is available and an unqualified identifier is used, the generator emits an error.

### Explicit source roots

Phase 1 defines these explicit roots for code form:

- `root` for the generated `x:Class` instance
- `self` for the target object receiving the value
- `named` for named elements in the current WPF name scope
- `templateParent` for the templated parent when inside template scopes

Examples:

```xaml
<TextBlock Text="{xsg:Expr Path=Title, SourceRoot=Root}" />

<TextBlock.Text>
    <xsg:Expr><![CDATA[$"{named.SearchBox.Text} ({ResultCount})"]]></xsg:Expr>
</TextBlock.Text>

<Rectangle.Width>
    <xsg:Expr><![CDATA[self.ActualHeight * 2]]></xsg:Expr>
</Rectangle.Width>
```

The proposal intentionally does not use MAUI's `this.` and `.Foo` syntax.

### Static member access

Static member access is allowed only with explicit qualification in phase 1.

Example:

```xaml
<xsg:Expr Evaluation="Once"><![CDATA[global::System.IO.Path.GetFileName(root.DocumentPath)]]></xsg:Expr>
```

This rule is intentionally strict. It avoids ambiguous resolution between a source member and a static type.

### Element names and name scopes

`named.X` is a compile-time-checked way to refer to an element in the current WPF name scope. It is conceptually aligned with `ElementName`, not with `x:Reference`.

This matters because `x:Reference` is a XAML 2009 feature and is not supported in WPF markup-compiled XAML and BAML. A WPF expression feature should therefore align with `ElementName` behavior instead of treating `x:Reference` as a normal primitive.

### Relative sources

Path form supports WPF source-selection properties directly:

- `SourceRoot=Self`
- `SourceRoot=Root`
- `SourceRoot=TemplateParent`
- `ElementName=...`
- `RelativeSource=...`

Examples:

```xaml
<TextBlock Text="{xsg:Expr Path=ActualWidth, SourceRoot=Self}" />
<TextBlock Text="{xsg:Expr Path=Header, SourceRoot=TemplateParent}" />
<TextBlock Text="{xsg:Expr Path=DataContext.Title, RelativeSource={RelativeSource FindAncestor, AncestorType={x:Type local:ShellView}}}" />
```

For code form, phase 1 supports `root`, `self`, `named`, and `templateParent` as explicit roots. Full mixed-source `FindAncestor` expressions inside code form are deferred unless the implementation can preserve clear diagnostics and predictable name resolution.

## Language Surface in Code Form

The expression language in code form is ordinary C#.

This proposal does not redefine:

- string literals
- char literals
- operators
- interpolation syntax
- casts
- null-coalescing
- conditional expressions

That means there are no word-based operator aliases and no single-quote string rewriting.

### Supported live-expression subset in phase 1

Phase 1 live expressions support the following constructs:

- literals
- member access
- null literals
- parenthesized expressions
- indexers where the leaf can still be lowered to a valid WPF binding path
- arithmetic operators
- comparison operators
- boolean operators
- null-coalescing `??`
- conditional `?:`
- casts, `is`, and `as`
- string interpolation

### Method calls in live expressions

This proposal intentionally does not support arbitrary method calls in live expressions in phase 1.

That is a deliberate difference from the more permissive shape implied by the MAUI proposal examples. The reason is not that method calls are impossible. The reason is that invalidation semantics become unclear very quickly.

For example, a parameterless method such as `GetTaxRate()` may look harmless, but a binding system has no clear way to know when it should be re-run unless the author also specifies what changes should invalidate it. Rather than invent a weak and surprising rule, phase 1 keeps live expressions observable and dataflow-oriented.

Method calls remain allowed under `Evaluation="Once"`.

### Unsupported constructs in phase 1

The following constructs are rejected in live expressions:

- assignments
- increment and decrement operators
- `await`
- lambdas and anonymous methods
- object creation expressions
- collection expressions and collection initializers
- statement blocks
- query expressions
- `dynamic`
- `ref`, `out`, `in`, pointer, and `unsafe` constructs
- arbitrary method invocations

## Lowering Model

The core lowering rule is simple.

Path expressions lower to the narrowest standard WPF construct that preserves meaning.

Code expressions lower to a binding graph plus generated helper code when they are live, or to generated one-time initialization code when they are explicitly once-only.

### Path lowering

A path expression against the current data source lowers to a `Binding` with a `Path`.

Example:

```xaml
<TextBlock Text="{xsg:Expr Path=Customer.Name}" />
```

Conceptually, this lowers to:

```xaml
<TextBlock Text="{Binding Customer.Name}" />
```

Path expressions against `Self`, `Root`, `ElementName`, and `RelativeSource` lower to `Binding` configurations that use those standard WPF binding source mechanisms.

### Template-parent optimization

When all of the following are true:

- the source is the templated parent
- the expression is a pure path
- the target context is a template where `TemplateBinding` is valid
- the effective mode is one-way
- both ends are dependency-property compatible in the way required by WPF

then the generator may lower to `TemplateBinding` instead of a general `Binding`.

Otherwise it lowers to a normal `Binding RelativeSource={RelativeSource TemplatedParent}`.

This matters because `TemplateBinding` is not just another spelling. It is a WPF-native optimization and a familiar template authoring concept.

### Live code-form lowering

A live code expression is lowered in three steps.

1. Step 1. Observable leaves are collected.
2. Step 2. Each observable leaf is lowered to a normal WPF `Binding`.
3. Step 3. The generator emits a strongly typed helper that combines those leaf values and evaluates the expression result.

Examples of leaves include:

- `FirstName`
- `LastName`
- `named.SearchBox.Text`
- `self.ActualWidth`
- `templateParent.IsEnabled`

For a single leaf, the generator may use a generated `IValueConverter`-style helper.

For multiple leaves, the generator may use `MultiBinding` plus a generated `IMultiValueConverter`-style helper.

Example:

```xaml
<TextBlock.Text>
    <xsg:Expr><![CDATA[$"{FirstName} {LastName}"]]></xsg:Expr>
</TextBlock.Text>
```

Conceptually, this lowers to a `MultiBinding` over `FirstName` and `LastName`, plus generated helper logic that performs the interpolation.

### Once-only lowering

An expression marked `Evaluation="Once"` is emitted as generated code in the partial initialization path.

That generated code may reference:

- the current root instance
- the target object
- named elements already initialized in scope
- literal and static values

However, the result is not live and does not participate in binding updates.

### No silent downgrade

If an expression in `Live` mode contains a value that cannot be observed with the supported lowering model, the generator must report a diagnostic. It must not silently switch to `Once`.

## Binding Modes

Path expressions support normal WPF binding modes, including `OneWay`, `TwoWay`, `OneTime`, `OneWayToSource`, and `Default`, subject to normal WPF rules for the target property and source property.

Live code expressions support only:

- `OneWay`
- `OneTime`

in phase 1.

This is another intentional difference from the more ambitious MAUI shape.

The reason is straightforward. A computed expression such as:

```csharp
FirstName + " " + LastName
```

has no obvious reverse mapping. A general-purpose `ConvertBack` is not something the generator should invent silently.

Future versions may add an explicit reverse-path surface, but phase 1 should not pretend that all expressions are naturally reversible.

### Read-only source properties

The design must treat read-only source properties correctly.

A source property that is read-only is valid for `OneWay` or `OneTime` flows. It must not be treated as assignable merely because the target property happens to default to two-way binding.

This point deserves to be explicit because the current MAUI implementation history has already shown bugs in this area.

## PropertyPath and WPF-Specific Path Semantics

Path form uses WPF `PropertyPath` semantics, not a made-up dot grammar.

That means phase 1 path mode may include WPF path features such as:

- dotted property access
- indexers
- attached-property syntax where valid through `PropertyPath`

This is important because WPF already has a mature path language. A WPF proposal should use it where it fits instead of inventing a parallel one.

Code form does not attempt to invent a general attached-property access syntax in phase 1. If authors need attached-property authoring, path form remains the preferred surface.

## Templates, Styles, and Triggers

The proposal should be explicit about where the feature is intended to work well in phase 1.

### Good phase 1 scenarios include

- values on ordinary dependency properties in windows, user controls, and pages
- values inside data templates where `xsg:DataType` is known
- control-template values that map to templated-parent paths or simple code expressions over observable leaves
- element-to-element expressions inside a single namescope

### Scenarios that should be deferred unless implemented carefully include

- expressions inside style setters where the target instance and name scope are non-obvious
- complex cross-name-scope references in templates
- mixed `FindAncestor` plus named-element plus data-source expressions in a single code expression
- any scenario that requires hidden runtime service lookups just to preserve the illusion of ordinary C# scope

## Resource Interop

Resources remain WPF-native.

This proposal does not add `resources.Foo` lookup syntax in phase 1.

If a value is already best expressed as a resource reference, authors should continue to use:

- `{StaticResource ...}`
- `{DynamicResource ...}`
- `x:Static`

The expression feature is not intended to become a parallel resource system.

## Diagnostics

Diagnostic quality is part of the proposal.

An implementation should provide stable diagnostic IDs, source mapping, and messages written in terms of the original XAML source.

Illustrative diagnostic set:

- `XSGC1001` error: ordinary `{...}` remains WPF markup extension syntax; use `xsg:Expr` for expressions
- `XSGC1002` error: unqualified identifier requires an active `xsg:DataType`
- `XSGC1003` error: ambiguous static or type resolution is not allowed; qualify the static type explicitly
- `XSGC1004` error: live expression uses an unsupported construct
- `XSGC1005` error: live computed expression cannot be `TwoWay` or `OneWayToSource`
- `XSGC1006` error: non-observable value in `Live` mode; mark `Evaluation="Once"` or rewrite as a live binding expression
- `XSGC1007` error: arbitrary method calls are not supported in live expressions in phase 1
- `XSGC1008` error: `x:Reference`-style behavior is not valid in markup-compiled WPF; use `ElementName` or a supported source root
- `XSGC1009` warning: path against templated parent could not lower to `TemplateBinding`; general `Binding` generated instead
- `XSGC1010` warning: attribute form is difficult to parse or escape; object-element form is recommended

### Source mapping requirement

The implementation should emit line pragmas or equivalent source mapping so that Roslyn diagnostics and debugger views point back to the XAML file and line whenever practical.

## Generated Code Requirements

The generated code is part of the authoring contract.

The implementation should:

- generate stable helper names
- avoid unnecessary reflection in the hot path
- keep generated bindings readable in the emitted `.g.cs` or equivalent output
- preserve enough structure that developers can inspect how a given expression was lowered
- preserve XAML line mapping whenever possible

## Examples

### Simple path against DataContext

```xaml
<TextBlock Text="{xsg:Expr Path=Customer.Name}" />
```

### Simple path against the root object

```xaml
<TextBlock Text="{xsg:Expr Path=Title, SourceRoot=Root}" />
```

### Element-to-element path

```xaml
<TextBlock Text="{xsg:Expr Path=Text, ElementName=SearchBox}" />
```

### Self path

```xaml
<Rectangle Height="{xsg:Expr Path=ActualWidth, SourceRoot=Self}" />
```

### Template-parent path eligible for `TemplateBinding` lowering

```xaml
<Border Padding="{xsg:Expr Path=Padding, SourceRoot=TemplateParent}" />
```

### Live computed expression over data leaves

```xaml
<TextBlock.Text>
    <xsg:Expr><![CDATA[$"{FirstName} {LastName}"]]></xsg:Expr>
</TextBlock.Text>
```

### Live computed expression mixing data and named elements

```xaml
<TextBlock.Text>
    <xsg:Expr><![CDATA[$"{named.SearchBox.Text} ({ResultCount})"]]></xsg:Expr>
</TextBlock.Text>
```

### Live expression against `self`

```xaml
<Rectangle.Width>
    <xsg:Expr><![CDATA[self.ActualHeight * 2]]></xsg:Expr>
</Rectangle.Width>
```

### Once-only static expression

```xaml
<TextBlock.Text>
    <xsg:Expr Evaluation="Once"><![CDATA[global::System.DateTime.Now.ToString("D")]]></xsg:Expr>
</TextBlock.Text>
```

### Example of something intentionally rejected in phase 1

```xaml
<TextBlock.Text>
    <xsg:Expr><![CDATA[GetDisplayName(FirstName, LastName)]]></xsg:Expr>
</TextBlock.Text>
```

Rationale: the expression contains a method call. The author can either expose `DisplayName` from the view model, use a converter, or mark the expression as `Evaluation="Once"` if one-time behavior is really what they want.

## Comparison with the MAUI Surface

| MAUI direction | WPF C# proposal |
| --- | --- |
| Direct `{...}` expressions | Explicit `xsg:Expr` host |
| `{= ...}` disambiguation | Not needed because the host is explicit |
| `this.` and `.Foo` | `root`, `self`, `named`, `templateParent`, and data-only unqualified identifiers |
| Word-based operator aliases | Not supported; use ordinary C# and prefer object-element CDATA |
| Event lambdas | Deferred from phase 1 |
| Implicit fallback to one-time capture | Replaced with explicit `Evaluation="Once"` |
| Broad precedence between instance and static members | Explicit roots and explicit static qualification |
| General "simple path may be two-way, complex expression becomes one-way" | Path expressions follow WPF binding modes; computed live expressions are `OneWay` or `OneTime` only in phase 1 |

## Why this proposal is intentionally narrower

This proposal is narrower than MAUI in several places on purpose.

That is not because WPF is incapable of supporting richer expressions. It is because the first version of a WPF expression feature should optimize for trust:

- trust that existing WPF XAML still means what it used to mean
- trust that an expression is live only when it is actually live
- trust that the generated code can be inspected
- trust that an error points back to the XAML line that caused it
- trust that `Customer.Name` means the data source, not an arbitrary resolution fallback

If a future version expands the language surface, it should do so from that stable base.

## Future Considerations

A later revision may consider the following extensions:

- explicit reverse mapping for computed expressions, conceptually similar to a `BindBack`-style surface
- carefully scoped support for pure method calls in live expressions when invalidation sources are explicit
- richer `FindAncestor` support in code form
- better integration with style setters and triggers
- resource-aware helper generation where the resource reference remains WPF-native
- optional analyzers that suggest when a view-model computed property would be clearer than an inline expression
- an explicit event-expression proposal, separate from the value-expression proposal

## Recommended Phase 1 Scope

If this proposal is implemented incrementally, the recommended phase 1 scope is:

1. `xsg:DataType`
2. `xsg:Expr` path form
3. `xsg:Expr` code form with object-element syntax as the recommended form
4. explicit `Evaluation="Once"`
5. explicit roots: `root`, `self`, `named`, `templateParent`
6. live lowering through `Binding`, `MultiBinding`, `RelativeSource`, and `TemplateBinding` where applicable
7. strong diagnostics and XAML source mapping

Everything else should be considered optional follow-up work.

## Conclusion

The MAUI proposal is useful because it proves that XAML expressions can be treated as a real compiler and tooling feature. It is not useful as a literal template for WPF.

For WPF, the better design is explicit host syntax, explicit source roots, WPF-native lowering, no silent capture, and a narrower but more trustworthy live-expression subset.

That design still delivers something meaningful: compile-time-checked paths, small computed values in XAML, and a clear bridge between declarative WPF authoring and Roslyn-backed tooling.

Most importantly, it does so without pretending that WPF's XAML rules, template model, event model, and binding model are the same as MAUI's.
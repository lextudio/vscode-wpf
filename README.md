# VS Code Tools for WPF

[![Become a Sponsor](https://img.shields.io/badge/Become%20a%20Sponsor-lextudio-orange.svg?style=for-readme)](https://github.com/sponsors/lextudio)
[![Stable Version](https://img.shields.io/visual-studio-marketplace/v/lextudio.vscode-wpf.svg?label=stable&color=)](https://marketplace.visualstudio.com/items?itemName=lextudio.vscode-wpf)
[![Install Count](https://img.shields.io/visual-studio-marketplace/i/lextudio.vscode-wpf.svg)](https://marketplace.visualstudio.com/items?itemName=lextudio.vscode-wpf)
[![Download Count](https://img.shields.io/visual-studio-marketplace/d/lextudio.vscode-wpf.svg)](https://marketplace.visualstudio.com/items?itemName=lextudio.vscode-wpf)

This is a VS Code extension targeting `.xaml` files for WPF projects. Different from many similar extensions, this one delivers you a full feature
development experience for WPF with open source components

- WPF designer originated from SharpDevelop 4
- XAML Source Generator (XSG) based language server
- Runtime startup-hook based XAML Hot Reload
- VS Code toolbox drag/drop for XAML controls
- Out-of-process live preview pane (`WPF Live Preview`) fed by runtime protocol snapshots

> Note that to inspect runtime state of your WPF apps, tools like [Snoop](https://github.com/snoopwpf/snoopwpf) can be used. We might explore how to integrate them in this extension in the future.

## Getting started

- Activates on `*.xaml` files.
- Click the `Hot Reload`, `Live Preview`, or `Designer` actions on the top-right of your XAML editor tab.
- Use the Explorer side bar views:
  - `WPF Toolbox` to drag controls into XAML editors.
- `WPF Live Preview` opens as an editor-side panel when the `Live Preview` action is clicked.

## Status

The visual designer for WPF from SharpDevelop is stable.

The language server and XAML Hot Reload for WPF are under development.

WPF on .NET 8+ is the focus. WPF on older .NET or .NET Core releases are best efforts.

WPF on .NET Framework is being investigated, but no promise on whether it will be supported.

## License

MIT

## Copyright

2026 (c) LeXtudio Inc. All rights reserved.

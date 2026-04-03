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

**This extension is independent and unaffiliated with Microsoft.**

![Visual designer screenshot](https://www.lextudio.com/images/wpf-designer.png)

> [Watch our Hot Reload demo video](https://www.lextudio.com/videos/wpf-hot-reload.mp4)
>
> Note that to inspect runtime state of your WPF apps, tools like [Snoop](https://github.com/snoopwpf/snoopwpf) can be used. We might explore how to integrate them in this extension in the future.

## Getting started

### Recommended Companion Extension

For consistent formatting of your XAML files, we recommend optionally installing the community **XAML Styler** extension (`dabbinavo.xamlstyler`). The first time you use this extension you'll receive a prompt; you can also find it manually in the Extensions view by searching for "XAML Styler". This extension is optional—the WPF features work without it.

### Using the Extension

- Activates on `*.xaml` files.
- Click the `Hot Reload` or `Launch Designer` actions on the top-right of your XAML editor tab.
- Use the Explorer side bar views:
  - `WPF: Toolbox` to drag controls into XAML editors.
- Use `WPF: Open XAML File` from Command Palette (or right-click a `.csproj` in Explorer) to open linked/non-discoverable XAML files.

## Status

The visual designer for WPF from SharpDevelop is stable.

The language server and XAML Hot Reload for WPF are under development.

XAML Hot Reload helper and visual designer currently target:

- .NET Core / modern .NET WPF apps via `netcoreapp3.0` helper (supports .NET Core 3.1+ and newer)
- .NET Framework WPF apps via `net462` helper (including .NET Framework 4.6.2 and newer)

## License

MIT

## Copyright

2026 (c) LeXtudio Inc. All rights reserved.

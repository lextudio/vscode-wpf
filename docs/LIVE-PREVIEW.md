# XAML Live Preview Design Specification

## Goals

Microsoft documents its design and features in [this article](https://learn.microsoft.com/visualstudio/xaml-tools/xaml-live-preview?view=visualstudio), and we can see many features like zooming are quite useful.

## Technical Details

It seems to rely on UI capture from live app, and then stream to a pane within VS. A few key API calls were listed in the article, so that we can call the same to implement a similar Live Preview experience in VS Code.

Besides, we developed a Live Preview based on WPF designer and removed it completed in 41839d8c80993ea2679d455dea28b2c4d3e8c2c8. That experiment had a few nice building blocks that might help us in this round of investigation.

## Design

TODO

# VS Code Tools for WPF

This is a VS Code extension targeting `.xaml` files for WPF projects.

## Getting started

- Activates on `*.xaml` files.
- A simple hover provider showing the word under the cursor.

## Packaging and publishing

On Windows use the PowerShell script:

```
npm run package:win    # builds and packages using publish.ps1
npm run package:publish:win   # builds, packages and publishes (requires vsce login)
```

Both commands call `npm run build` (esbuild) and then `npx vsce package`. For publishing they call `npx vsce publish` — ensure you're logged in (`npx vsce login <publisher>`).

Versioning workflow

- Tag a release in git using a `v` prefix, e.g. `git tag v1.0.0` and push the tag.
- The publish script will read the latest tag and update `package.json` version automatically before packaging.
- You can run the updater manually with:

```
npm run version:git
```

Then package with:

```
npm run package:win
```

GitVersion integration

This repository can use GitVersion to compute the semantic version instead of relying on manual tags. If `gitversion` is installed on the PATH the publish flow will prefer it automatically.

Install GitVersion (Windows examples):

- Via Chocolatey: `choco install gitversion.portable`
- Or via dotnet tool: `dotnet tool install --global GitVersion.Tool`

After installing, run:

```
npm run version:gitversion
```

This will update `package.json` to the version computed by GitVersion, then you can run the packaging script.

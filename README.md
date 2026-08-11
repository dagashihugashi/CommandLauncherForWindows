# Windows Maneuver

A fast, keyboard-driven, terminal-styled application launcher for Windows, built with Tauri + React. Press a hotkey, start typing, and launch apps, switch windows, search the web, do quick math, or run system commands — all without leaving the keyboard.

## Installation

Two ways to get it:

- **Installer (recommended)** — Download and run either the `.msi` or the `-setup.exe` from the [Releases](../../releases) page. This installs the app and sets up WebView2 if it isn't already present.
- **Portable ZIP** — Download the ZIP, extract it anywhere, and run `windows-maneuver.exe`. No installation needed. A `config.json` will be created automatically next to the exe the first time you save a custom command or change a setting — you don't need to provide one yourself.

**Requirement:** Windows Maneuver renders its UI with Microsoft Edge WebView2. Windows 11 has the WebView2 Runtime built in. On Windows 10, most systems already have it (it ships with Edge updates), but if the app fails to start, install the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) first — this is only relevant for the portable ZIP, since the installers handle it automatically.

Windows Maneuver runs as a background app. Escape only hides the search window — it doesn't quit the app, since it needs to stay resident for the hotkey to keep working. There's no tray icon or in-app quit command yet, so to fully exit, end `windows-maneuver.exe` from Task Manager.

## Getting Started

Press **Alt+Space** (the default hotkey — see [Settings](#settings)) to open the launcher, and again to hide it. Start typing to search; press **Enter** to launch the top/selected result; use **↑ / ↓** to move through the list.

## Features

### App & window search

Type to fuzzy-search:
- Apps found in your Start Menu
- Currently open windows (selecting one switches to it instead of opening a new instance)
- Your custom commands (see below)

Matching apps show their real icon (shortcut arrows are resolved away so you get the clean app icon). Icons are only fetched for the results actually shown on screen, so the search stays fast even with a large Start Menu.

Items you launch often or recently are ranked higher over time (frecency), on top of the normal fuzzy match ranking.

### Custom commands

Type `add command` and press Enter (or select it from the results) to open the command wizard. It asks, one line at a time:

1. **Name** — the keyword you'll type to find/launch it (must be unique)
2. **Target** — a URL or a local file/app path
3. **Description** — optional
4. **Enable query mode?** — see [Query search](#query-search) below

Confirm with `y` to save. Existing commands can be edited or deleted from the search results list (hover over a custom command to reveal the `edit` / `delete` buttons).

### Query search

Turn any custom command into a site-search shortcut. Type its name followed by a space (e.g. `g react`), and the prompt switches to a dedicated query line where you type your search terms:

```
[WindowsManeuver]> g
[google]> react
```

Press Enter to open the search. How the query gets inserted into the Target URL:
- If the Target contains a literal `{query}` placeholder, your search text is substituted there (use this for sites with non-standard search parameters, e.g. `https://www.youtube.com/results?search_query={query}`).
- Otherwise, if **query mode** was enabled for that command, your search text is appended automatically as `?q=...` (or `&q=...`), which works out of the box for most search engines (Google, Bing, DuckDuckGo, ...). This means the same Target you'd use to just open the site also works for searching it — no special syntax required.

A built-in default is always available even with no commands configured: `g` searches Google.

### Inline math

Type a math expression (e.g. `12*(3+4)/2`) and press Enter — the search box is replaced with the result. Supports `+ - * / % ^`, parentheses, and unary minus. If the expression is invalid, an error is shown in the search box instead.

### System commands (`/...`)

Type `/` to see the available system commands, or type the full name and press Enter. These are kept in a separate `/`-prefixed namespace so they never collide with your own commands.

| Command | Effect | Confirmation |
|---|---|---|
| `/sleep` | Sleep the PC | none |
| `/lock` | Lock the PC (Win+L equivalent) | none |
| `/hibernate` | Hibernate the PC | none |
| `/explorer` | Open File Explorer | none |
| `/shutdown` | Shut down the PC | y/n |
| `/restart` | Restart the PC | y/n |
| `/logoff` | Sign out of the PC | y/n |
| `/emptytrash` | Empty the Recycle Bin | y/n |
| `/settings` | Open the settings screen | — |

Commands requiring confirmation switch to a `[Are you sure?]` prompt; answer `y`/`yes` or `n`/`no`. Anything else is rejected with an inline error. Press Escape, Ctrl+C, or Backspace (on an empty line) to back out without running the command.

### Settings

Type `/settings` to open the settings wizard. It walks through each value one at a time, prefilled with your current setting — press Enter to keep it, or type a new value:

| Setting | Format | Notes |
|---|---|---|
| Background color | `#rrggbb` | Main window background |
| Window opacity | `0.1`–`1.0` | How see-through the window is; `1.0` = fully opaque |
| Text color | `#rrggbb` | Primary text color |
| Alert text color | `#rrggbb` | Inline validation warnings (e.g. "necessary") |
| Success popup color | `#rrggbb` | Background of the success toast |
| Error popup color | `#rrggbb` | Background of the error toast |
| Hotkey | e.g. `Alt+Space` | Global shortcut to show/hide the launcher |

Colors are validated as `#rrggbb` hex and show a live swatch. The hotkey is validated by actually attempting to register it with Windows before saving, so you can't accidentally save one that doesn't work; if a saved hotkey ever fails to register (e.g. edited by hand into an invalid value), Windows Maneuver automatically falls back to the default (`Alt+Space`) and shows an error, so the app can't lock you out of your own hotkey. Confirm with `y` to save and apply immediately — no restart needed.

## Keyboard reference

| Key | Action |
|---|---|
| Hotkey (default `Alt+Space`) | Show / hide the launcher |
| ↑ / ↓ | Move through results |
| Enter | Launch selected result / confirm current step |
| Escape | Hide the launcher (from the top-level search), or back out one level from query search, a `/` command confirmation, Add/Edit Command, or Settings |
| Ctrl+C | Same as Escape for backing out of a sub-screen |
| Backspace (on an empty sub-input) | Step back to the previous line (query search / `/` command confirmation) |

## Development

This is a Tauri v2 + React + TypeScript project.

```sh
npm install
npm run tauri dev    # run in development
npm run tauri build  # produce release binaries + installers
```

### Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

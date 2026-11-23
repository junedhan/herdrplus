# Herdr Plus

**Stay in Herdr when you need to read, move, or transfer a file.**

I started this fork because I liked running multiple coding agents in Herdr, but still opened VS Code for everyday tasks like reading a Markdown file, uploading an attachment, or moving a file between folders. Herdr Plus brings those tasks into the **Files** panel, right beside your terminals and agents.

## Herdr Plus at a glance

Herdr Plus keeps Herdr's spaces, agent and terminal tabs, split panes, SSH workspaces, and persistent Core sessions. The comparison uses the [upstream commit this fork is based on](https://github.com/herdrdev/herdr-app/commit/317e673f1f1568b876cbaa0b41dabeb9153ecbea).

| Workflow | Herdr Desktop | Herdr Plus on `master` |
| --- | --- | --- |
| **Read source and logs** | Syntax-highlighted, read-only source preview. | Word wrap on by default, a wrap toggle, and a labeled excerpt for large text files. |
| **Read Markdown and HTML** | Opens source in the text viewer. | Rendered Markdown and basic HTML, with one click back to **Raw**. |
| **Browse several files and folders** | One preview takes the place of the file tree. | Full-height preview tabs inside **Files**. Right-click files or folders for **Open in New Tab**. Choose **Explorer** to return to the workspace tree. |
| **Inspect images** | The Files viewer reads text. | Preview PNG, JPEG, WebP, GIF, BMP, ICO, TIFF, and AVIF with **Fit** and **100%** views. Animated images show a still frame. |
| **See what's inside an archive** | The Files viewer reads text. | Search the first 500 paths in ZIP and TAR-family archives, including sizes where available. The preview reads archive metadata without extracting files. |
| **Scan CSV or TSV** | Opens delimited data as text. | Switch between a table and **Raw**. The table shows up to 150 rows and 24 columns. |
| **Check a PDF** | The Files viewer reads text. | Preview page one when Poppler is available. Use **Download** for the full document. |
| **Upload from Explorer** | The Files panel lists and previews workspace entries. | On Windows, drop one or more files onto a folder, a file in the target folder, or the Files header. Transfers work with local and connected Unix workspaces. |
| **Download to your computer** | The Files panel lists and previews workspace entries. | Open a file and choose **Download**. Select the destination folder on your computer. Existing files are preserved. |
| **Move items inside Files** | Clicking a folder expands it and clicking a file opens its preview. | Drag files and folders between directories. The item name follows the cursor, the destination lights up, holding over a folder opens it, and dragging near an edge scrolls. **Esc** cancels. |
| **Manage files from the tree** | Read-only browsing and previews. | Right-click to create a file or folder, rename, cut, copy, paste, or delete. Cut and paste work within the same machine. Delete asks for confirmation. |
| **Follow transfer progress** | Transfer controls are outside the Files panel. | A small spinner and status in the Files header leave the list or preview in place. |
| **Select and copy table data** | Select raw CSV or TSV text in the source viewer. | Drag to select text in the rendered grid, or use **Copy table** to copy the displayed cells as tab-separated data. |
| **Open an Excel workbook** | The Files viewer reads text. | Preview `.xlsx` and `.xlsm`, switch worksheets, and copy cells. Requires Python 3 on the file's machine. |
| **Close to the Windows system tray** | Closing the window leaves terminal sessions running in Core. | **X** hides the main window in the tray. Click its icon to restore it. Choose **Quit Herdr** from the tray menu or Settings to exit the desktop app while Core keeps sessions running. |

Remote image previews can use the server's Pillow or FFmpeg. On Windows, when
the server lacks a renderer, supported images and PDFs up to 64 MiB can use
a temporary local copy. Image previews are scaled to a maximum of 1,600 px
on the longest side. PDF rendering requires Poppler.

**Which file task still sends you back to another editor?** Share it in
[Issues](https://github.com/junedhan/herdrplus/issues), or open a pull request.
Drag-and-drop reports are especially helpful when they mention the OS and
whether the workspace is local or remote.

## Install Herdr Plus

Follow [Build from source](#build-from-source) to try this fork.

## Install upstream Herdr

These installers are for the upstream desktop app.

### Linux and macOS

```sh
curl -fsSL https://releases.herdr.dev/app/install.sh | sh
```

Linux needs a desktop session and a working Vulkan driver. macOS builds are available for Apple Silicon; Intel Mac users can [build from source](#build-from-source). Linux builds are x86-64 and ARM64.

The installer adds Herdr to your apps and puts the command in `~/.local/bin`.
Add that folder to your PATH if the installer asks.
On macOS the app lives in `~/Applications/Herdr.app`.
For drag-and-drop installation on Apple Silicon, download [Herdr.dmg](https://releases.herdr.dev/app/Herdr.dmg) and drag Herdr to Applications.

On macOS (Apple Silicon), you can also install with [Homebrew](https://brew.sh/):

```sh
brew install --cask herdr-app
```

### Windows

Run in PowerShell on x64 Windows with curl and tar installed (Windows 10 1803 or newer):

```powershell
irm https://releases.herdr.dev/app/install.ps1 | iex
```

Herdr appears in the Start menu. The installer adds `%LOCALAPPDATA%\Programs\herdr-app` to your user PATH. Open a new terminal to pick it up.

The shell and PowerShell installers download and run code. Read the [shell installer](distribution/install.sh) or [PowerShell installer](distribution/install.ps1) first if you prefer.
They also install [herdr-core](https://github.com/herdrdev/herdr-core) if it is missing.
The app can help install or update a core it cannot use.

## Find your work

A **space** holds work on one machine, usually in one repo. Each space has **tabs**. Split a tab into **panes** to put terminals or mod panels beside each other.

An unnamed space follows its first terminal's folder. Name a space or tab when you want a label that stays.
New tabs start in the focused terminal's folder.

The agents sidebar brings agents from your spaces into one list, including workers started by another agent.
Agents that report status show as:

- **Working:** still busy.
- **Blocked:** waiting for you.
- **Done:** finished while you were looking elsewhere.
- **Idle:** not working, or a finished agent you have looked at.

Click an agent to see it. A worker without a pane opens in **peek**, over your tab. Keep it as a tab if you want it beside your other work.
Ctrl-click a live terminal address in terminal text to peek at it; use Cmd-click on macOS.
An address such as `t7` means a terminal on the same machine as the terminal showing it. `vps/t7` names one on another machine.

The window arranges terminals. The core runs them.
Closing the window leaves them running; closing a pane or tab ends its terminals.
After a reboot or core crash, kept panes get fresh shells in their last folders, not their old programs.

## Work on another machine

Add an SSH machine from Settings → Machines or the sidebar's Add machine action.
Pick a host from your SSH config or type how SSH reaches it.
Spaces on that machine run their terminals there, not on your computer.

Each machine keeps its spaces, tabs and splits in its core. Connected screens share that structure and the live terminals, but keep their own focus and zoom.
Remote work keeps running when your local window closes or your laptop sleeps, as long as the remote machine and core stay up.

## Make it yours

Open the command palette to find an action by name, or open Settings to change fonts, colors, sounds and other preferences.
Settings > Look also adjusts terminal line height, cell width and scroll speed. All default to 100%; layouts can override them with `terminal_line_height` (0.8–2), `terminal_cell_width` (0.8–2) and `terminal_scroll_speed` (0.1–5).
The built-in layouts include Herdr, Terminals and Herdr 98.
A **layout** arranges the window. **Mods** are small JavaScript programs that draw its panels, menus and dialogs.

Duplicate a shipped layout or mod before changing its structure or code. Your copies stay yours; Herdr updates the shipped ones on start.
Save a personal layout, mod or key file and the window reloads it.
A broken edit keeps the last good version and reports the error.

Ctrl+Shift+P shows every command and its key (Cmd+Shift+P on macOS). Change any key in `keys.json`; see [the keys section](defaults/AGENTS.md#keys-keysjson) of the mod guide for the format, including JSON objects for named, typed command arguments.

On macOS, Cmd+A selects the terminal's whole screen and scrollback, ready for Cmd+C.
In vim and other alternate-screen apps, it selects only that screen.
Linux and Windows keep Ctrl+A for the shell; bind `terminal.select_all` in `keys.json` if desired.

[Layouts and mods](docs/mods.md) · [Commands](docs/commands.md)

## Updates and privacy

Installed releases check for updates in the background and download a new app beside the running one. It takes over when you quit and reopen, or choose the update action. Your terminals keep running in the core.
Settings → Updates shows what is available. What's New opens after an update; you can open it again from the command palette.
Builds from source do not update themselves.

Usage telemetry is on by default in releases. Turn it off in Settings → Privacy.
Mods are trusted code, not sandboxed extensions. Read [security and privacy](docs/security.md) before installing someone else's mod.

## For agents

```sh
herdr-app --skill
```

This prints the agent guide for driving the window. The herdr-core skill points agents here.
Use herdr-core for running and coordinating programs; use the app to change what you see.

```sh
herdr-app ls
herdr-app status
herdr-app commands
```

The first two inspect the open window. The command list also works without one.
See the [command reference](docs/commands.md) for arguments.

## Build from source

For bugs, mod API requests and code contributions, see [Contributing](CONTRIBUTING.md).

Clone this repo with its submodules. Use Rust 1.95.0 and Zig 0.16.0, the versions used in [CI](.github/workflows/ci.yml).
Linux needs the development packages listed in that workflow.

```sh
git clone --recurse-submodules https://github.com/junedhan/herdrplus.git
cd herdrplus
just build
just test
just install
```

Install [just](https://github.com/casey/just) to use these recipes.
The platform installer builds a release and adds the app to your desktop.
On Linux it links to this checkout, so keep the checkout in place.
Quit and reopen Herdr to use the new build.

Documentation checks also need [Bun](https://bun.sh): `just docs-check` checks generated pages and CLI examples; `just docs-generate` refreshes the reference pages.

To compare drawing changes on Windows, Linux or macOS, run the same fixed workloads against each build:

```sh
python scripts/bench.py --bin <app executable> --set spinners --seconds 20
```

The runner requires `hc` on PATH and uses the Python executable running the script. It prints a unique artifact folder with the run settings, counters and results, then stops its private app, terminals and core. Every set uses Python fixture programs; the default set’s TUI workload replaces historical `btop` measurements. `--only spinners` measures just the quiet native spinner scenario. `--set titles` runs eight agents whose titles spin after a prefix (`π ⠹ task`) on the main layout. Keep the window visible and the display awake, and compare the same window activity and display settings; inactive windows may draw at a lower rate. Windows records visibility, foreground activity and display Hz at each measurement boundary; other platforms mark these observations unavailable. Visibility does not establish occlusion. Draws are window render calls. Render-to-paint elapsed time stops before scene finalization, backend drawing, uploads and presentation; it is separate from OS process CPU time. Neither measures physical presentation or the FPS HUD’s derived MAX FPS.

`python scripts/bench_compare.py ghostty --root <artifact folder>` reuses a run’s fake agent for the macOS comparison. Benchmark checks: `python -m unittest discover -s scripts -p test_bench.py`.

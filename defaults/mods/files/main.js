// A lazy file browser for the focused pane's folder, with previews and local file copies.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, ScrollHandle, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, pickFolder } from "herdr";
import { listArchive, loadImagePreview, loadWorkbook, parseTable, powershell, previewFormat, psQuote, readTextExcerpt, releasePreview, windows, windowsArg } from "./file-preview.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / 1024 ** unit).toFixed(1) + " " + ["B", "KiB", "MiB", "GiB", "TiB"][unit];
}
const publishCopy = 'umask 077; temp=$(mktemp -d "$1/.herdr-copy-XXXXXXXX") || exit; ' +
  'trap \'rm -f "$temp/$2"; rmdir "$temp"\' EXIT; ' +
  'cat > "$temp/$2" && ln "$temp/$2" "$1/"';

async function remoteCopy(source, folder, name, on, upload, output, maxBytes) {
  // Core accepts at most 8 MB per piped invocation. Keep each request smaller.
  const coreArgs = (...args) => psQuote(["exec", "--on", on, "--timeout", "90", ...args].map(windowsArg).join(" "));
  const setup = "$chunk = 4194304; $buffer = New-Object byte[] $chunk; " +
    "$hc = Get-Command hc.exe, herdr-core.exe -ErrorAction SilentlyContinue | Select-Object -First 1; " +
    "if (!$hc) { throw 'Herdr Core executable is missing from PATH' }; " +
    "function Invoke-Core($arguments, $inputLength, $outputFile) { " +
    "$info = New-Object Diagnostics.ProcessStartInfo; " +
    "$info.FileName = $hc.Source; $info.UseShellExecute = $false; $info.CreateNoWindow = $true; " +
    "$info.Arguments = $arguments; $info.RedirectStandardInput = $inputLength -gt 0; " +
    "$info.RedirectStandardOutput = $null -ne $outputFile; " +
    "$child = [Diagnostics.Process]::Start($info); " +
    "try { if ($inputLength -gt 0) { " +
    "$child.StandardInput.BaseStream.Write($buffer, 0, $inputLength); $child.StandardInput.Close() }; " +
    "if ($null -ne $outputFile) { $child.StandardOutput.BaseStream.CopyTo($outputFile) }; " +
    "$child.WaitForExit(); if ($child.ExitCode -ne 0) { throw 'Herdr Core transfer failed' } " +
    "} finally { if (!$child.HasExited) { $child.Kill() }; $child.Dispose() } }; ";
  if (upload) {
    const staging = folder + "/.herdr-copy-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const temp = staging + "/" + name;
    const mkdir = coreArgs("--", "mkdir", "-m", "700", "--", staging);
    const append = coreArgs("-i", "--", "sh", "-c", 'umask 077; cat >> "$1"', "files-copy", temp);
    const publish = coreArgs("--", "sh", "-c", 'umask 077; (test -e "$1" || : > "$1") && ln "$1" "$2/"', "files-copy", temp, folder);
    const cleanup = coreArgs("--", "sh", "-c", 'rm -f -- "$1"; rmdir -- "$2"', "files-copy", temp, staging);
    await powershell(setup + "$file = [IO.File]::OpenRead(" + psQuote(source) + "); " +
      "try { Invoke-Core " + mkdir + " 0 $null; try { " +
      "while (($count = $file.Read($buffer, 0, $chunk)) -gt 0) { Invoke-Core " + append + " $count $null }; " +
      "Invoke-Core " + publish + " 0 $null " +
      "} finally { Invoke-Core " + cleanup + " 0 $null } } finally { $file.Dispose() }");
    return;
  }
  const read = coreArgs("--", "sh", "-c", 'test -f "$1" && dd if="$1" bs=4194304 skip="$2" count=1 2>/dev/null', "files-copy", source);
  await powershell(setup + "$dest = " + psQuote(output ?? folder + "/" + name) + "; " +
    "$temp = [IO.Path]::Combine([IO.Path]::GetDirectoryName($dest), '.herdr-copy-' + [guid]::NewGuid()); " +
    "try { $file = [IO.File]::Open($temp, 'CreateNew'); try { $index = 0; do { " +
    "$start = $file.Position; Invoke-Core (" + read + " + ' ' + $index) 0 $file; $index++; " +
    (maxBytes ? "if ($file.Position -gt " + maxBytes + ") { throw 'File exceeds the preview transfer limit' }; " : "") +
    "} while ($file.Position - $start -eq $chunk) } finally { $file.Dispose() }; " +
    "[IO.File]::Move($temp, $dest) } finally { [IO.File]::Delete($temp) }");
}

async function copyFile(source, folder, on, upload) {
  const name = source.split(windows() && (!on || upload) ? /[\\/]/ : "/").pop();
  if (!name || name === "." || name === "..") throw new Error("Invalid file name");
  if (on) {
    if (!upload && /[\\/:*?"<>|\x00-\x1f]|[. ]$/.test(name)) throw new Error("This file name cannot be saved on Windows");
    await remoteCopy(source, folder, name, on, upload);
    return;
  }
  const destination = folder + "/" + name;
  if (windows()) {
    await powershell("$dest = " + psQuote(destination) + "; " +
      "$temp = [IO.Path]::Combine([IO.Path]::GetDirectoryName($dest), '.herdr-copy-' + [guid]::NewGuid()); " +
      "try { [IO.File]::Copy(" + psQuote(source) + ", $temp, $false); [IO.File]::Move($temp, $dest) } " +
      "finally { [IO.File]::Delete($temp) }");
  } else {
    const result = await exec("sh", ["-c",
      'test -f "$1" || { echo "Choose a regular file" >&2; exit 1; }; source=$1; shift; ' +
      'exec 0< "$source"; ' + publishCopy,
      "files-copy", source, folder, name], { timeout: 600000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "File copy failed");
  }
}

const unixManage = `
import os, shutil, subprocess, sys
op, src, dst = sys.argv[1:]
if op == "new-file":
    open(dst, "xb").close()
elif op == "new-folder":
    os.mkdir(dst)
elif op == "delete":
    if os.path.isdir(src) and not os.path.islink(src):
        shutil.rmtree(src)
    else:
        os.unlink(src)
else:
    is_directory = os.path.isdir(src) and not os.path.islink(src)
    if is_directory and os.path.commonpath([os.path.realpath(src), os.path.realpath(dst)]) == os.path.realpath(src):
        raise ValueError("Choose a destination outside the source folder")
    if os.path.lexists(dst):
        raise FileExistsError("An item with that name already exists")
    if op == "move":
        subprocess.run(["mv", "-nT", "--", src, dst], check=True)
        if os.path.lexists(src):
            raise FileExistsError("The source could not be moved without replacing another item")
    elif os.path.islink(src):
        os.symlink(os.readlink(src), dst)
    elif is_directory:
        os.mkdir(dst, 0o700)
        try:
            shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True)
        except BaseException:
            shutil.rmtree(dst)
            raise
    elif os.path.isfile(src):
        with open(src, "rb") as original, open(dst, "xb") as target:
            try:
                shutil.copyfileobj(original, target)
                shutil.copystat(src, dst)
            except BaseException:
                os.unlink(dst)
                raise
    else:
        raise ValueError("This item cannot be copied")
`;

const windowsManage = {
  "new-file": "[IO.File]::Open($dst, 'CreateNew').Dispose()",
  "new-folder": "if (Test-Path -LiteralPath $dst) { throw 'An item with that name already exists' }; [IO.Directory]::CreateDirectory($dst) | Out-Null",
  move: "if ([IO.Directory]::Exists($src)) { [IO.Directory]::Move($src, $dst) } else { [IO.File]::Move($src, $dst) }",
  copy: "if (![IO.Directory]::Exists($src)) { [IO.File]::Copy($src, $dst, $false); return }; " +
    "$from = [IO.Path]::GetFullPath($src).TrimEnd([char]92) + [char]92; " +
    "$to = [IO.Path]::GetFullPath($dst).TrimEnd([char]92) + [char]92; " +
    "if ($to.StartsWith($from, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose a destination outside the source folder' }; " +
    "function Copy-Contents($from, $to) { " +
    "foreach ($item in Get-ChildItem -LiteralPath $from -Force) { " +
    "if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Folder contains a link or reparse point' }; " +
    "$next = [IO.Path]::Combine($to, $item.Name); " +
    "if ($item.PSIsContainer) { [IO.Directory]::CreateDirectory($next) | Out-Null; Copy-Contents $item.FullName $next } " +
    "else { [IO.File]::Copy($item.FullName, $next, $false) } } }; " +
    "$stage = [IO.Path]::Combine([IO.Path]::GetDirectoryName($dst), '.herdr-copy-' + [guid]::NewGuid()); " +
    "$parent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($dst)); " +
    "while ($parent) { if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Choose a folder outside a link or reparse point' }; $parent = $parent.Parent }; " +
    "[IO.Directory]::CreateDirectory($stage) | Out-Null; " +
    "try { Copy-Contents $src $stage; [IO.Directory]::Move($stage, $dst) } " +
    "finally { if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) } }",
  delete: "$item = Get-Item -LiteralPath $src -Force; " +
    "if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Use Explorer to remove this link or reparse point' }; " +
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    "if ([IO.Directory]::Exists($src)) { " +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($src, 'OnlyErrorDialogs', 'SendToRecycleBin') " +
    "} else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($src, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
};

async function manageFile(op, source, destination, on) {
  if (!on && windows()) {
    await powershell("$src = " + psQuote(source.replaceAll("/", "\\")) +
      "; $dst = " + psQuote(destination.replaceAll("/", "\\")) + "; " + windowsManage[op]);
    return;
  }
  const result = await exec("python3", ["-c", unixManage, op, source, destination], { on, timeout: 120000 });
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || "File operation failed");
}

function validName(name, localWindows) {
  if (!name || name === "." || name === ".." || name.toLowerCase() === ".git" ||
      /[/\x00-\x1f]/.test(name) || (localWindows &&
      (/[\\:*?"<>|]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)))) {
    throw new Error("Enter a valid name for one item");
  }
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.tabs = [];
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.folderErrors = new Map(); this.marks = {};
    this.nameInput = InputState.new({ value: "" });
    this.nameInput.on("submit", (_e, cx) => this.submitAction(cx));
    this.archiveSearch = InputState.new({ value: "" });
    this.archiveSearch.on("change", (_e, cx) => {
      if (this.activeTab?.kind === "file") this.activeTab.archiveQuery = this.archiveSearch.value();
      cx.notify();
    });
    this.focus = cx.focus_handle();
    this.treeScroll = ScrollHandle.new();
    this.tabScroll = ScrollHandle.new();
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.timer.every(300, cx => {
      if (this.dropHover && !this.drag?.active && Date.now() - this.lastDropMove > 1800) {
        this.dropHover = null; cx.notify();
      }
    });
    cx.timer.every(100, cx => {
      const drag = this.drag, bounds = this.panelBounds;
      if (!drag || !bounds) return;
      const pointer = globalThis.window.mouse_position();
      if (pointer.x < bounds.x || pointer.x >= bounds.x + bounds.width ||
          pointer.y < bounds.y || pointer.y >= bounds.y + bounds.height) {
        this.drag = this.dropHover = null;
        cx.notify();
        return;
      }
      if (!drag.active || !drag.scroll) return;
      const { index, step } = drag.scroll;
      const next = Math.max(0, Math.min(this.rowCount - 1, index + step));
      if (next !== index) {
        drag.scroll.index = next;
        drag.target = this.dropHover = null;
        this.treeScroll.scroll_to_item(next);
        cx.notify();
      }
    });
  }

  async close() {
    const tabs = this.tabs;
    this.tabs = [];
    await Promise.all(tabs.map(tab => releasePreview(tab.media?.absolute)));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    let entries;
    try { entries = await directory(path ? `${root}/${path}` : root, on); }
    catch (error) {
      if (this.current(context)) { this.folderErrors.set(path, String(error)); this.entries.delete(path); }
      return;
    }
    if (!this.current(context) || (path && !this.folders.has(path) && !this.tabs.some(tab => tab.kind === "folder" && tab.path === path))) return;
    this.folderErrors.delete(path);
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) {
        this.saved.set(this.context.key, {
          folders: this.folders,
          tabs: this.tabs.map(({ kind, path, raw, wrap, detail, archiveQuery, sheet }) => ({ kind, path, raw, wrap, detail, archiveQuery, sheet })),
          active: this.tabs.indexOf(this.activeTab),
          tree: this.tabs.indexOf(this.treeTab),
        });
        for (const tab of this.tabs) this.releaseTab(tab, cx);
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.tabs = saved?.tabs ?? [];
      this.activeTab = this.tabs[saved?.active];
      this.treeTab = this.tabs[saved?.tree];
      this.pending = new Set(); this.folderErrors = new Map(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      this.transferStatus = null;
      this.menu = this.action = this.dropHover = this.drag = null;
      const tab = this.activeTab;
      if (tab?.kind === "file") cx.spawn(async cx => { if (this.activeTab === tab) this.activateTab(tab, cx); });
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        const paths = new Set(["", ...this.folders, ...this.tabs.filter(tab => tab.kind === "folder").map(tab => tab.path)]);
        for (const path of paths) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        if (!this.tabs.some(tab => tab.kind === "folder" && tab.path === folder)) this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      this.ensureFolder(path, cx);
    }
    cx.notify();
  }

  ensureFolder(path, cx) {
    if (this.entries.has(path) || this.pending.has(path)) return;
    const context = this.context;
    this.pending.add(path);
    cx.spawn(async cx => {
      try { await this.loadFolder(path, context); }
      catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
    });
  }

  openTab(path, kind, cx) {
    let tab = this.tabs.find(tab => tab.path === path && tab.kind === kind);
    if (!tab) {
      tab = { path, kind };
      this.tabs.push(tab);
    }
    this.activateTab(tab, cx);
  }

  activateTab(tab, cx) {
    if (tab && !this.tabs.includes(tab)) return;
    this.activeTab = tab;
    if (!tab || tab.kind === "folder") this.treeTab = tab;
    this.menu = this.action = this.dropHover = this.drag = null;
    this.tabScroll.scroll_to_item(tab ? this.tabs.indexOf(tab) + 1 : 0);
    if (tab?.kind === "file") {
      this.archiveSearch.set_value(tab.archiveQuery ?? "");
      if (!tab.started) this.loadFile(tab, cx);
    }
    if (tab?.kind === "folder") this.ensureFolder(tab.path, cx);
    cx.notify();
  }

  releaseTab(tab, cx) {
    if (!tab.code && !tab.media) return;
    cx.spawn(async () => {
      tab.code?.release();
      await releasePreview(tab.media?.absolute);
    });
  }

  closeTab(tab, cx) {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    this.releaseTab(tab, cx);
    if (this.treeTab === tab) this.treeTab = undefined;
    if (this.activeTab === tab) this.activateTab(this.tabs[index] ?? this.tabs[index - 1], cx);
    else cx.notify();
  }

  loadFile(tab, cx) {
    const format = previewFormat(tab.path);
    if (format.kind === "workbook") {
      this.loadSheet(tab, tab.sheet ?? 0, cx);
      return;
    }
    const request = tab.request = {};
    tab.started = tab.loading = true;
    tab.format = format.kind;
    tab.raw ??= !format.kind;
    tab.wrap ??= true;
    const context = this.context, root = this.root, on = this.on;
    const file = root + "/" + tab.path;
    const current = () => this.tabs.includes(tab) && tab.request === request && this.current(context);
    cx.spawn(async cx => {
      try {
        if (format.kind === "legacy-excel") {
          tab.error = "Preview supports .xlsx and .xlsm workbooks. Download this file to open it in Excel.";
          return;
        }
        if (format.kind === "image" || format.kind === "pdf") {
          const preview = await loadImagePreview(file, format, on,
            output => remoteCopy(file, "", "", on, false, output, 64 * 1024 * 1024));
          if (current()) tab.media = preview;
          else await releasePreview(preview.absolute);
          return;
        }
        if (format.kind === "archive") {
          const archive = await listArchive(file, format.ext, on);
          if (current()) tab.archive = archive;
          return;
        }
        let excerpt = false;
        const text = await readTextFile(file, { on }).catch(error => {
          if (!String(error).includes("exceeds 1 MiB")) throw error;
          excerpt = true;
          return readTextExcerpt(file, on);
        });
        if (!current()) return;
        if (text === null) { tab.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { tab.error = "Binary file · no text preview"; return; }
        tab.language = format.ext;
        tab.source = text.slice(0, 400000);
        tab.truncated = excerpt || tab.source.length < text.length;
        if (format.kind === "table") {
          this.setTable(tab, parseTable(tab.source.replace(/^\uFEFF/, ""), format.ext === "tsv" ? "\t" : ","));
        }
        this.createEditor(tab);
      } catch {
        if (!current()) return;
        tab.error = format.kind === "image" ? "Cannot decode this image for preview. You can still download the original."
          : format.kind === "pdf" ? "Cannot render page one. PDF preview requires Poppler. You can still download the original."
          : format.kind === "archive" ? "Cannot read this archive’s file list. It may be damaged or the archive reader may be unavailable."
          : "Cannot preview this file as text. It may be binary, unreadable, or larger than 1 MiB.";
      }
      finally { if (current()) { tab.loading = false; cx.notify(); } }
    });
  }

  loadSheet(tab, sheet, cx) {
    const context = this.context, request = tab.request = {};
    const file = this.root + "/" + tab.path, on = this.on;
    tab.started = tab.loading = true;
    tab.error = null;
    const current = () => this.tabs.includes(tab) && tab.request === request && this.current(context);
    cx.spawn(async cx => {
      try {
        const workbook = await loadWorkbook(file, on, sheet);
        if (!current()) return;
        tab.sheet = workbook.sheet;
        tab.sheets = workbook.sheets;
        this.setTable(tab, workbook);
      } catch {
        if (current()) tab.error = "Cannot read this worksheet. Excel preview requires Python 3 on the machine where the file is stored.";
      } finally {
        if (current()) { tab.loading = false; cx.notify(); }
      }
    });
    cx.notify();
  }

  setTable(tab, table) {
    const escape = value => String(value).replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
    const width = Math.max(0, ...table.rows.map(row => row.length));
    const rows = table.rows.map((row, index) =>
      "<tr><th>" + escape(table.rowNumbers?.[index] ?? index + 1) + "</th>" +
      Array.from({ length: width }, (_, i) => "<td>" + escape(row[i] ?? "").replace(/[\r\n]+/g, " ") + "</td>").join("") + "</tr>");
    tab.table = table;
    tab.tableWidth = width;
    tab.tableHtml = "<table><tbody>" + rows.join("") + "</tbody></table>";
  }

  copyTable(tab, cx) {
    const quote = value => /["\r\n\t]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
    const text = tab.table.rows.map(row => Array.from({ length: tab.tableWidth }, (_, i) => quote(row[i] ?? "")).join("\t")).join("\r\n");
    cx.write_to_clipboard(text);
    this.transferStatus = "Copied displayed cells";
    this.clearStatusSoon(this.context, cx);
    cx.notify();
  }

  createEditor(tab) {
    const t = theme(), language = tab.language;
    const code = EditorState.new({ language: LANG[language] ?? language, readonly: true,
      value: tab.source, soft_wrap: tab.wrap,
      font_family: settings().font_family, font_size: settings().font_size,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    tab.code?.release();
    tab.code = code;
  }

  button(id, label, action, t) {
    return div().id(id).flex_none().px(7).py(4).rounded(5).cursor_pointer()
      .text_size(12).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  contextMenu(element, target) {
    return element.on_mouse_down("right", (event, cx) => {
      if (!this.root || this.action) return;
      cx.stop_propagation();
      this.dropHover = null;
      this.focus.focus();
      this.menu = { ...target, point: event.position };
      cx.notify();
    });
  }

  dismiss(cx) {
    this.menu = this.action = null;
    cx.notify();
  }

  pickAction(op, target, cx) {
    this.menu = null;
    if (op === "open-tab") {
      this.openTab(target.path, target.isFolder ? "folder" : "file", cx);
    } else if (op === "copy" || op === "cut") {
      this.clipboard = { path: this.root + "/" + target.path, name: target.path.split("/").pop(), on: this.on, cut: op === "cut" };
    } else if (op === "paste") {
      const item = this.clipboard;
      if (item && item.on === this.on) this.runAction(item.cut ? "move" : "copy", item.path,
        this.root + "/" + (target.folder ? target.folder + "/" : "") + item.name, cx, item);
    } else {
      this.action = { op, target, error: null };
      if (op !== "delete") {
        const name = op === "rename" ? target.path.split("/").pop() : "";
        this.nameInput.set_value(name);
        this.nameInput.set_selected_range({ start: 0, end: name.length });
        cx.timer.after(30, () => this.nameInput.focus());
      }
    }
    cx.notify();
  }

  submitAction(cx) {
    if (!this.action || !this.current(this.context) || this.managing) return;
    const { op, target } = this.action;
    const source = target.path ? this.root + "/" + target.path : "";
    let destination = "";
    if (op !== "delete") {
      const name = this.nameInput.value();
      try { validName(name, !this.on && windows()); }
      catch (error) { this.action.error = error.message; cx.notify(); return; }
      const folder = op === "rename" ? target.path.split("/").slice(0, -1).join("/") : target.folder;
      destination = this.root + "/" + (folder ? folder + "/" : "") + name;
      if (op === "rename" && source === destination) { this.dismiss(cx); return; }
    }
    this.runAction(op === "rename" ? "move" : op, source, destination, cx);
  }

  runAction(op, source, destination, cx, clipboard) {
    if (this.managing) return;
    const context = this.context, prompt = this.action;
    this.managing = true;
    this.transferStatus = op === "move" ? "Moving…" : op === "copy" ? "Copying…" : "Working…";
    cx.spawn(async cx => {
      try {
        await manageFile(op, source, destination, context.on);
        if (clipboard?.cut && this.clipboard === clipboard) this.clipboard = null;
        if (!this.current(context)) return;
        this.transferStatus = op === "move" ? "Moved " + destination.split("/").pop()
          : op === "copy" ? "Copied " + destination.split("/").pop() : null;
        if (this.transferStatus) this.clearStatusSoon(context, cx);
        if (op === "move" || op === "delete") {
          const prefix = source.slice(context.cwd.length + 1);
          const movedTo = destination.slice(context.cwd.length + 1);
          for (const folder of this.folders) {
            if (folder === prefix || folder.startsWith(prefix + "/")) {
              this.folders.delete(folder); this.entries.delete(folder);
            }
          }
          for (const tab of [...this.tabs]) {
            if (tab.path !== prefix && !tab.path.startsWith(prefix + "/")) continue;
            if (op === "delete") this.closeTab(tab, cx);
            else {
              this.entries.delete(tab.path);
              tab.path = movedTo + tab.path.slice(prefix.length);
              if (tab.loading) this.loadFile(tab, cx);
            }
          }
        }
        this.dismiss(cx);
        this.refresh(cx);
      } catch (error) {
        if (!this.current(context)) return;
        if (prompt && this.action === prompt) { this.transferStatus = null; prompt.error = error.message; }
        else this.transferStatus = error.message;
      } finally { this.managing = false; cx.notify(); }
    });
    cx.notify();
  }

  renderMenu(t) {
    const target = this.menu, bounds = this.panelBounds;
    const width = Math.max(1, Math.min(188, (bounds?.width ?? 196) - 8));
    const x = bounds ? Math.max(4, Math.min(target.point.x - bounds.x, bounds.width - width - 4)) : 4;
    const count = target.path ? 8 : 3;
    const y = bounds ? Math.max(4, Math.min(target.point.y - bounds.y, bounds.height - count * 25 - 14)) : 44;
    const row = (op, label, disabled = false) => div().id("files-menu-" + op).h(25).px(8).flex().items_center().rounded(4)
      .text_color(disabled ? t.dim : op === "delete" ? t.ansi1 : t.foreground)
      .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => {
        cx.stop_propagation(); this.pickAction(op, target, cx);
      })).child(label);
    return v_flex().id("files-menu").absolute().left(x).top(y).w(width).p(4).rounded(7)
      .shadow_md().bg(t.popover).border_1().border_color(t.border)
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .when(Boolean(target.path), el => el.child(row("open-tab", "Open in New Tab")))
      .child(row("new-file", "New file…")).child(row("new-folder", "New folder…"))
      .when(Boolean(target.path), el => el.child(row("cut", "Cut")).child(row("copy", "Copy")))
      .child(row("paste", "Paste", !this.clipboard || this.clipboard.on !== this.on))
      .when(Boolean(target.path), el => el.child(row("rename", "Rename…")).child(row("delete", "Delete…")));
  }

  renderAction(t) {
    const { op, target, error } = this.action;
    const title = { "new-file": "New file", "new-folder": "New folder", rename: "Rename", delete: "Delete" }[op];
    const remove = op === "delete";
    const recycled = !this.on && windows();
    return v_flex().id("files-action").absolute().top(44).left(6).right(6).p(10).gap(7)
      .rounded(7).shadow_md().border_1().border_color(t.border).bg(t.popover)
      .child(div().font_semibold().child(title))
      .child(remove ? div().child((recycled ? "Move to Recycle Bin: " : "Permanently delete: ") + target.path)
        : Input.new(this.nameInput).h(30).px(8).rounded(5).bg(t.background).border_1().border_color(t.input))
      .when(Boolean(error), el => el.child(div().text_color(t.ansi1).child(error)))
      .child(h_flex().justify_end()
        .child(this.button("files-action-cancel", "Cancel", cx => this.dismiss(cx), t))
        .child(this.button("files-action-submit", this.managing ? "Working…" : title, cx => this.submitAction(cx), t)));
  }

  canTransfer() {
    return !this.on || windows();
  }

  clearStatusSoon(context, cx) {
    const status = this.transferStatus;
    cx.timer.after(3000, cx => {
      if (!this.transferring && !this.managing && this.current(context) && this.transferStatus === status) {
        this.transferStatus = null; cx.notify();
      }
    });
  }

  transfer(cx, choose, upload) {
    if (!this.canTransfer() || this.transferring || this.managing) return;
    const context = this.context;
    this.transferring = true;
    this.transferStatus = upload ? "Copying files…" : "Preparing download…";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const { paths, folder } = await choose();
        const errors = [];
        let copied = 0;
        for (const path of paths) {
          try { await copyFile(path, folder, context.on, upload); copied++; }
          catch (error) { errors.push(path + ": " + error.message); }
        }
        if (this.current(context)) {
          this.transferStatus = [copied ? "Copied " + copied + (copied === 1 ? " file" : " files") : "", ...errors]
            .filter(Boolean).join("\n");
          if (copied && !errors.length) this.clearStatusSoon(context, cx);
          if (copied) this.refresh(cx);
        }
      } catch (error) {
        if (this.current(context)) this.transferStatus = error.message;
      } finally {
        this.transferring = false;
        cx.notify();
      }
    });
  }

  moveDestination(path, folder) {
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    if (parent === folder || folder === path || folder.startsWith(path + "/")) return null;
    return (folder ? folder + "/" : "") + path.slice(slash + 1);
  }

  updateDragTarget(event, folder, row, index, cx) {
    const drag = this.drag;
    drag.active ||= Math.hypot(event.position.x - drag.start.x, event.position.y - drag.start.y) >= 5;
    if (!drag.active) return;
    const previous = drag.target;
    drag.point = event.position;
    drag.rowIndex = index;
    const allowed = this.moveDestination(drag.path, folder) && !this.managing && !this.transferring;
    if (previous?.row !== row || previous.allowed !== Boolean(allowed)) {
      const target = drag.target = { row, folder, allowed: Boolean(allowed) };
      this.dropHover = allowed ? { row, folder } : null;
      if (allowed && folder && !this.folders.has(folder)) {
        cx.timer.after(650, cx => {
          if (this.drag === drag && drag.target === target && this.current(drag.context) && !this.folders.has(folder)) {
            this.toggle(folder, cx);
          }
        });
      }
    }
    cx.notify();
  }

  dragPreview(t) {
    const { path, point, isFolder, target } = this.drag;
    const bounds = this.panelBounds;
    const width = Math.max(1, Math.min(210, bounds.width - 8));
    const x = point.x - bounds.x, y = point.y - bounds.y;
    const left = Math.max(4, Math.min(x + 13, bounds.width - width - 4));
    const top = y + 58 < bounds.height ? y + 13 : Math.max(4, y - 54);
    const hint = target?.allowed
      ? (target.folder ? "Move to " + target.folder.split("/").pop() : "Move to root")
      : target ? "Choose another folder" : "Choose a folder";
    return h_flex().absolute().left(left).top(top).w(width).p(7).gap(7).items_center()
      .rounded(7).shadow_md().border_1().border_color(target?.allowed ? t.accent : t.border).bg(t.popover)
      .child(svg(`mods/files/${isFolder ? "folder" : "file"}.svg`).size(15).flex_none().text_color(t.accent))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().font_medium().child(path.split("/").pop()))
        .child(div().truncate().text_size(11).text_color(t.dim).child(hint)));
  }

  finishDrop(event, folder, path, isFolder, cx) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = this.dropHover = null;
    cx.stop_propagation();
    cx.notify();
    if (!this.current(drag.context) || this.menu || this.action) return;
    const moved = drag.active || Math.hypot(event.position.x - drag.start.x, event.position.y - drag.start.y) >= 5;
    if (!moved) {
      if (path === drag.path) isFolder ? this.toggle(path, cx) : this.openTab(path, "file", cx);
      return;
    }
    const destination = this.moveDestination(drag.path, folder);
    if (!destination || this.managing || this.transferring) return;
    if (folder && !this.folders.has(folder)) this.toggle(folder, cx);
    this.runAction("move", this.root + "/" + drag.path, this.root + "/" + destination, cx);
  }

  dropTarget(element, folder, row, t, path, isFolder, index) {
    if (!this.root) return element;
    return element.when(this.dropHover?.row === row, el => el.bg(t.selected))
      .when(Boolean(path), el => el.on_mouse_down("left", (event, cx) => {
        if (this.menu || this.action || !this.current(this.context)) return;
        this.focus.focus();
        this.drag = { path, isFolder, start: event.position, context: this.context, active: false };
        cx.stop_propagation();
      }))
      .on_mouse_move((event, cx) => {
        this.lastDropMove = Date.now();
        if (this.drag) {
          this.updateDragTarget(event, folder, row, index, cx);
          return;
        }
        if (this.dropHover?.row === row) return;
        this.dropHover = { row, folder };
        cx.notify();
      })
      .on_mouse_up("left", (event, cx) => this.finishDrop(event, folder, path, isFolder, cx))
      .when(this.canTransfer(), el => el.on_drop((event, cx) => {
      cx.stop_propagation();
      this.drag = null;
      this.dropHover = null;
      cx.notify();
      if (this.transferring || !event.paths.length || !this.current(this.context)) return;
      const destination = folder ? this.root + "/" + folder : this.root;
      if (folder && !this.folders.has(folder)) this.toggle(folder, cx);
      this.transfer(cx, () => ({ paths: event.paths, folder: destination }), true);
    }));
  }

  download(tab, cx) {
    const source = this.root + "/" + tab.path;
    this.transfer(cx, async () => {
      const folder = await pickFolder({ prompt: "Download to folder" });
      return { folder, paths: folder ? [source] : [] };
    });
  }

  previewFile(tab, t) {
    if (tab.media) {
      const { asset, width, height } = tab.media;
      return v_flex().id("files-image-" + tab.path).flex_1().min_h(0).min_w(0).p(8)
        .when(tab.detail, el => el.overflow_scrollbar())
        .when(!tab.detail, el => el.overflow_hidden())
        .child(image(asset).id(asset)
          .when(tab.detail, el => el.w(width).h(height).flex_none())
          .when(!tab.detail, el => el.size_full()));
    }
    if (tab.archive) return this.previewArchive(tab, t);
    if (tab.table && !tab.raw) return this.previewTable(tab, t);
    if (!tab.code) return div().p(12).text_color(t.dim).child(tab.error || "Loading file…");
    if (tab.raw) return Editor.new(tab.code).flex_1().min_h(0).min_w(0);
    return TextView[tab.format]("files-preview-" + tab.path, tab.source)
      .selectable().scrollable().flex_1().min_h(0).min_w(0).p(12);
  }

  previewArchive(tab, t) {
    const query = (tab.archiveQuery ?? "").trim().toLowerCase();
    const entries = tab.archive.entries.filter(([name]) => name.toLowerCase().includes(query));
    const summary = (tab.archive.truncated ? "First " : "") + tab.archive.entries.length + " entries";
    const readable = name => name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
    return v_flex().flex_1().min_h(0).min_w(0).gap(4).p(8)
      .child(Input.new(this.archiveSearch).h(29).px(7).rounded(5).border_1().border_color(t.input))
      .child(div().text_size(11).text_color(t.dim).child(query ? entries.length + " matches · " + summary : summary + " · Filter by path"))
      .child(v_flex().id("files-archive-" + tab.path).flex_1().min_h(0).overflow_y_scrollbar()
        .when(!entries.length, el => el.child(div().p(8).text_color(t.dim).child(query ? "No matching entries" : "Empty archive")))
        .children(entries.map(([name, size], index) => h_flex().id("archive-entry-" + index).h(25).flex_none().gap(6).items_center().px(4)
          .hover(el => el.bg(t.hover)).tooltip(readable(name))
          .child(svg("mods/files/" + (size === null ? "folder" : "file") + ".svg").size(13).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(readable(name)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(size === null ? "" : formatBytes(size))))));
  }

  previewTable(tab, t) {
    const { rows, truncated } = tab.table;
    return v_flex().flex_1().min_h(0).min_w(0).p(8).gap(5)
      .child(div().text_size(11).text_color(t.dim).child(rows.length + " rows · " + tab.tableWidth + " columns" + (truncated ? " · Preview limited" : "")))
      .when(Boolean(tab.error), el => el.child(div().text_size(11).text_color(t.ansi1).child(tab.error)))
      .when(Boolean(rows.length), el => el.child(TextView.html("files-table-" + tab.path + "-" + (tab.sheet ?? 0), tab.tableHtml)
        .selectable().scrollable().flex_1().min_h(0).min_w(0)));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const row = h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(this.drag?.active && this.drag.path === path, el => el.opacity(0.48))
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
      const folder = entry.dir ? path : prefix;
      const targeted = Boolean(folder && this.dropHover?.folder === folder && entry.dir);
      out.push(this.contextMenu(this.dropTarget(row, folder, "row:" + path, t, path, entry.dir, out.length)
        .when(targeted, el => el.bg(t.selected)), { path, folder, isFolder: entry.dir }));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  renderTabs(t) {
    const item = tab => {
      const id = tab ? tab.kind + "-" + tab.path : "explorer";
      const selected = this.activeTab === tab;
      return h_flex().id("files-tab-" + id).h(27).flex_none().items_center().rounded(5)
        .bg(selected ? t.selected : t.background)
        .child(h_flex().id("files-tab-open-" + id).h_full().min_w(0).max_w(158).px(7).gap(5).items_center()
          .cursor_pointer().rounded(5).text_color(selected ? t.foreground : t.muted).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.activateTab(tab, cx))
          .when(Boolean(tab), el => el.tooltip(tab.path)
            .child(svg("mods/files/" + (tab.kind === "folder" ? "folder" : "file") + ".svg").size(12).flex_none()))
          .child(div().min_w(0).truncate().child(tab ? tab.path.split("/").pop() : "Explorer")))
        .when(Boolean(tab), el => el.child(div().id("files-tab-close-" + id).size(21).flex_none().flex().items_center().justify_center()
          .rounded(4).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover)).tooltip("Close tab")
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(tab, cx); }).child("×")));
    };
    return h_flex().id("files-tabs").h(36).flex_none().items_center().gap(3).px(5)
      .border_b(1).border_color(t.border).overflow_x_scrollbar().track_scroll(this.tabScroll)
      .child(item(undefined)).children(this.tabs.map(item));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const file = this.activeTab?.kind === "file" ? this.activeTab : null;
    const scope = this.treeTab?.path ?? "";
    const root = { path: "", folder: scope };
    const rows = file ? [] : this.rows(scope, 0, [], t);
    this.rowCount = rows.length;
    return v_flex().id("files").relative().track_focus(this.focus).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_mouse_move((event) => { this.panelBounds = event.bounds; })
      .on_mouse_up("left", (_event, cx) => { if (this.drag) { this.drag = this.dropHover = null; cx.notify(); } })
      .on_mouse_down_out((_event, cx) => { if (this.drag) { this.drag = this.dropHover = null; cx.notify(); } })
      .on_key_down((event, cx) => {
        if (event.key === "escape" && this.drag) {
          this.drag = this.dropHover = null; cx.stop_propagation(); cx.notify(); return;
        }
        if (event.key === "escape" && (this.menu || this.action)) { cx.stop_propagation(); this.dismiss(cx); }
      })
      .child(h_flex().id("files-header").h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.root && !file), el => this.contextMenu(this.dropTarget(el, scope, "header", t), root)
          .on_mouse_move(() => { if (this.drag) this.drag.scroll = null; }))
        .child(div().font_semibold().child("Files"))
        .when(this.transferring || this.managing || file?.loading, el => el.child(svg("mods/workspace-chrome/spinner.svg")
          .size(11).flex_none().text_color(t.accent).spin(900)))
        .child(div().id("files-status").flex_1().min_w(0).truncate().text_right().text_size(12)
          .text_color(this.transferring || this.managing ? t.accent : t.dim)
          .when(Boolean(this.transferStatus), el => el.tooltip(this.transferStatus))
          .child(this.transferStatus?.split("\n")[0] || scope || this.root?.split(/[\\/]/).pop() || "")))
      .when(this.tabs.length > 0, el => el.child(this.renderTabs(t)))
      .when(!file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.treeScroll).p(6)
        .on_mouse_move(event => {
          const drag = this.drag;
          if (!drag?.active) return;
          const step = event.local_position.y < 26 ? -1 : event.local_position.y > event.bounds.height - 26 ? 1 : 0;
          drag.scroll = step && drag.rowIndex != null ? { step, index: drag.rowIndex } : null;
        })
        .children(rows)
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))
        .child(this.contextMenu(this.dropTarget(div().id("files-root-drop").flex_1().min_h(32).rounded(7)
          .when(Boolean(this.error || this.folderErrors.get(scope)) || !this.entries.get(scope)?.length, el => el.p(8).text_size(12).text_color(t.dim)
            .child(this.error || this.folderErrors.get(scope) || (this.pending.has(scope) || this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))), scope, "background", t), root))))
      .when(Boolean(file), el => el.child(h_flex().flex_none().flex_wrap().px(7).py(3).gap(4)
        .when(Boolean(file.code && file.format), el => el.child(this.button("files-mode", file.raw ? "Preview" : "Raw", cx => { file.raw = !file.raw; cx.notify(); }, t)))
        .when(Boolean(file.sheets?.length), el => el
          .when(file.sheet > 0, el => el.child(this.button("files-sheet-prev", "‹", cx => { if (!file.loading) this.loadSheet(file, file.sheet - 1, cx); }, t).tooltip("Previous worksheet")))
          .child(div().id("files-sheet-name").max_w(145).truncate().px(4).py(4).text_size(12)
            .tooltip(file.sheets[file.sheet]).child(file.sheets[file.sheet] + " (" + (file.sheet + 1) + "/" + file.sheets.length + ")"))
          .when(file.sheet + 1 < file.sheets.length, el => el.child(this.button("files-sheet-next", "›", cx => { if (!file.loading) this.loadSheet(file, file.sheet + 1, cx); }, t).tooltip("Next worksheet"))))
        .when(Boolean(file.table && !file.raw && file.table.rows.length && !file.loading), el => el.child(this.button("files-copy-table", "Copy table", cx => this.copyTable(file, cx), t)))
        .when(Boolean(file.media), el => el
          .child(this.button("files-detail", file.detail ? "Fit" : "100%", cx => { file.detail = !file.detail; cx.notify(); }, t))
          .child(div().flex_none().px(5).py(4).text_size(11).text_color(t.dim)
            .child(file.format === "pdf" ? "Page 1" : file.media.width + " × " + file.media.height + " preview")))
        .when(Boolean(file.code && file.raw), el => el.child(this.button("files-wrap", file.wrap ? "Wrap on" : "Wrap off", cx => {
          file.wrap = !file.wrap; this.createEditor(file); cx.notify();
        }, t)))
        .when(this.canTransfer(), el => el.child(this.button("files-download", "Download", cx => this.download(file, cx), t)))))
      .when(Boolean(file?.truncated), el => el.child(div().px(12).py(4).text_size(12).text_color(t.dim).child("Preview truncated")))
      .when(Boolean(file), el => el.child(this.previewFile(file, t)))
      .when(Boolean(this.menu), el => el.child(this.renderMenu(t)))
      .when(Boolean(this.action), el => el.child(this.renderAction(t)))
      .when(Boolean(this.drag?.active && this.drag.point && this.panelBounds), el => el.child(this.dragPreview(t)));
  }
}

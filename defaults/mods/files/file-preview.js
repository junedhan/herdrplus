import { appHome, exec, window } from "herdr";

export const windows = () => window()?.platform === "windows";
export const psQuote = value => "'" + value.replace(/['‘’‚‛]/g, "$&$&") + "'";
export const windowsArg = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&") + '"';

export async function powershell(script, timeout = 600000) {
  return command("powershell", ["-NoProfile", "-STA", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; " + script],
    { timeout });
}

async function command(program, args, options) {
  const result = await exec(program, args, options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "File preview command failed");
  return result.stdout.trim();
}

const IMAGE = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "tif", "tiff", "avif"]);
const CACHE = "data/files-preview";
const PAGE_SIZE = 1600;
const ARCHIVE_LIMIT = 500;
let sequence = 0;

export function previewFormat(path) {
  const filename = path.split("/").pop().toLowerCase();
  const ext = filename.includes(".") ? filename.split(".").pop() : "txt";
  if (IMAGE.has(ext)) return { kind: "image", ext };
  if (ext === "pdf") return { kind: "pdf", ext };
  if (ext === "zip") return { kind: "archive", ext };
  if (/\.(?:tar(?:\.(?:gz|bz2|xz))?|tgz|tbz2|txz)$/.test(filename)) return { kind: "archive", ext: "tar" };
  if (["csv", "tsv"].includes(ext)) return { kind: "table", ext };
  if (["md", "markdown", "mdown", "mkd"].includes(ext)) return { kind: "markdown", ext };
  if (["html", "htm"].includes(ext)) return { kind: "html", ext };
  return { kind: null, ext };
}

const pythonArchive = `
import itertools, json, os, sys, tarfile, zipfile
path, kind, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
if not os.path.isfile(path):
    raise ValueError("Archive is not a regular file")
def label(name):
    return name if len(name) <= 420 else name[:419] + "…"
if kind == "zip":
    with zipfile.ZipFile(path) as archive:
        entries = [[label(x.filename), None if x.is_dir() else x.file_size]
                   for x in itertools.islice(archive.infolist(), limit + 1)]
else:
    with tarfile.open(path, "r|*") as archive:
        entries = [[label(x.name), x.size if x.isfile() else None]
                   for x in itertools.islice(archive, limit + 1)]
print(json.dumps({"entries": entries[:limit], "truncated": len(entries) > limit}))
`;

export async function listArchive(path, ext, on) {
  if (windows() && !on && ext === "zip") {
    return JSON.parse(await powershell("Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      "$z = [IO.Compression.ZipFile]::OpenRead(" + psQuote(path) + "); " +
      "try { $rows = [Collections.Generic.List[object]]::new(); foreach ($entry in $z.Entries) { " +
      "if ($rows.Count -ge " + ARCHIVE_LIMIT + ") { break }; $name = $entry.FullName; " +
      "if ($name.Length -gt 420) { $name = $name.Substring(0,419) + [char]0x2026 }; " +
      "$size = if ($entry.FullName.EndsWith('/')) { $null } else { $entry.Length }; " +
      "$rows.Add(@($name, $size)) }; " +
      "ConvertTo-Json -InputObject @{ entries = $rows; truncated = ($z.Entries.Count -gt " + ARCHIVE_LIMIT + ") } -Depth 4 -Compress " +
      "} finally { $z.Dispose() }", 45000));
  }
  const python = windows() && !on ? "python" : "python3";
  return JSON.parse(await command(python, ["-c", pythonArchive, path, ext, String(ARCHIVE_LIMIT)], { on, timeout: 45000 }));
}

export async function readTextExcerpt(path, on) {
  if (windows() && !on) {
    return JSON.parse(await powershell(
      "$r = [IO.StreamReader]::new(" + psQuote(path) + ", [Text.UTF8Encoding]::new($false,$true), $true); " +
      "try { $chars = New-Object char[] 160000; $n = $r.ReadBlock($chars, 0, $chars.Length); " +
      "ConvertTo-Json -InputObject ([string]::new($chars, 0, $n)) -Compress } finally { $r.Dispose() }", 10000));
  }
  return JSON.parse(await command("python3", ["-c",
    "import codecs,json,os,sys; p=sys.argv[1]; assert os.path.isfile(p); f=open(p,'rb'); print(json.dumps(codecs.getincrementaldecoder('utf-8')().decode(f.read(160000))))",
    path], { on, timeout: 10000 }));
}

// Binary stdout goes directly to a generated cache asset. It never crosses the
// text-only exec result or needs an exposed HTTP server on either machine.
const pythonImage = `
import os, shutil, subprocess, sys
path, kind, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
if not os.path.isfile(path):
    raise ValueError("Preview needs a regular file")
if kind == "pdf":
    args = ["pdftoppm", "-f", "1", "-l", "1", "-singlefile", "-scale-to", str(size), "-png", path]
else:
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as image:
            if image.width * image.height > 100_000_000:
                raise ValueError("Image exceeds the 100 megapixel preview limit")
            image.draft("RGB", (size, size))
            image.thumbnail((size, size))
            image = ImageOps.exif_transpose(image)
            image = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
            image.save(sys.stdout.buffer, "PNG")
        sys.exit(0)
    except (ImportError, OSError):
        if not shutil.which("ffmpeg"):
            sys.exit("Raster preview needs Pillow or FFmpeg on this machine")
    args = ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
            "-max_pixels", "100000000", "-f", "image2", "-pattern_type", "none", "-i", path,
            "-frames:v", "1", "-vf", f"scale='min(iw,{size})':'min(ih,{size})':force_original_aspect_ratio=decrease",
            "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"]
subprocess.run(args, stdout=sys.stdout.buffer, check=True)
`;

function windowsImage(source, output) {
  return powershell("Add-Type -AssemblyName PresentationCore; " +
    "$path = " + psQuote(source) + "; " +
    "$stream = [IO.File]::OpenRead($path); try { " +
    "$frame = [Windows.Media.Imaging.BitmapDecoder]::Create($stream, 'DelayCreation', 'OnDemand').Frames[0]; " +
    "$w = $frame.PixelWidth; $h = $frame.PixelHeight " +
    "} finally { $stream.Dispose() }; " +
    "if ([long]$w * $h -gt 100000000) { throw 'Image exceeds the 100 megapixel preview limit' }; " +
    "$stream = [IO.File]::OpenRead($path); try { " +
    "$bitmap = New-Object Windows.Media.Imaging.BitmapImage; $bitmap.BeginInit(); $bitmap.StreamSource = $stream; " +
    "$bitmap.CacheOption = 'OnLoad'; " +
    "if ($w -ge $h -and $w -gt " + PAGE_SIZE + ") { $bitmap.DecodePixelWidth = " + PAGE_SIZE + " } " +
    "elseif ($h -gt " + PAGE_SIZE + ") { $bitmap.DecodePixelHeight = " + PAGE_SIZE + " }; $bitmap.EndInit(); " +
    "$png = New-Object Windows.Media.Imaging.PngBitmapEncoder; " +
    "$png.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap)); " +
    "$file = [IO.File]::Open(" + psQuote(output) + ", 'CreateNew'); try { $png.Save($file) } finally { $file.Dispose() } " +
    "} finally { $stream.Dispose() }", 45000);
}

function windowsBinary(program, args, output, remote) {
  const programExpression = remote
    ? "(Get-Command hc.exe, herdr-core.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source"
    : "(Get-Command " + psQuote(program) + " -ErrorAction Stop).Source";
  return powershell("$info = New-Object Diagnostics.ProcessStartInfo; $info.FileName = " + programExpression + "; " +
    "$info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; " +
    "$info.Arguments = " + psQuote(args.map(windowsArg).join(" ")) + "; " +
    "$file = [IO.File]::Open(" + psQuote(output) + ", 'CreateNew'); try { " +
    "$child = [Diagnostics.Process]::Start($info); try { $child.StandardOutput.BaseStream.CopyTo($file); " +
    "$child.WaitForExit(); if ($child.ExitCode -ne 0) { throw 'Image renderer failed' } " +
    "} finally { if (!$child.HasExited) { $child.Kill() }; $child.Dispose() } " +
    "} finally { $file.Dispose() }", 55000);
}

function renderImage(source, output, kind, on) {
  const args = ["-c", pythonImage, source, kind, String(PAGE_SIZE)];
  if (windows()) {
    if (on) return windowsBinary("hc.exe", ["exec", "--on", on, "--timeout", "45", "--", "python3", ...args], output, true);
    if (kind === "pdf") {
      return windowsBinary("pdftoppm.exe", ["-f", "1", "-l", "1", "-singlefile", "-scale-to", String(PAGE_SIZE), "-png", source], output, false);
    }
    return windowsBinary("ffmpeg.exe", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
      "-max_pixels", "100000000", "-f", "image2", "-pattern_type", "none", "-i", source,
      "-frames:v", "1", "-vf", `scale='min(iw,${PAGE_SIZE})':'min(ih,${PAGE_SIZE})':force_original_aspect_ratio=decrease`,
      "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], output, false);
  }
  const commandArgs = on ? ["hc", "exec", "--on", on, "--timeout", "45", "--", "python3", ...args] : ["python3", ...args];
  return command("sh", ["-c", 'umask 077; out=$1; shift; set -C; "$@" > "$out"', "files-preview", output, ...commandArgs], { timeout: 55000 });
}

async function cacheDirectory(path) {
  if (windows()) {
    await powershell("[IO.Directory]::CreateDirectory(" + psQuote(path) + ") | Out-Null", 5000);
  } else {
    await command("sh", ["-c", 'umask 077; mkdir -p -- "$1"', "files-preview", path], { timeout: 5000 });
  }
}

export async function releasePreview(path) {
  if (!path) return;
  try {
    if (windows()) await powershell("[IO.File]::Delete(" + psQuote(path) + ")", 5000);
    else await command("rm", ["-f", "--", path], { timeout: 5000 });
  } catch {}
}

async function dimensions(path) {
  const raw = windows()
    ? await powershell("$f = [IO.File]::OpenRead(" + psQuote(path) + "); try { " +
      "$b = New-Object byte[] 24; if ($f.Read($b,0,24) -ne 24 -or [BitConverter]::ToString($b,0,8) -ne '89-50-4E-47-0D-0A-1A-0A') { throw 'Renderer did not produce a PNG' }; " +
      "[array]::Reverse($b,16,4); [array]::Reverse($b,20,4); " +
      "[string][BitConverter]::ToUInt32($b,16) + ' ' + [string][BitConverter]::ToUInt32($b,20) " +
      "} finally { $f.Dispose() }", 5000)
    : await command("python3", ["-c", "import struct,sys; f=open(sys.argv[1],'rb'); b=f.read(24); assert b[:8] == b'\\x89PNG\\r\\n\\x1a\\n'; print(*struct.unpack('>II', b[16:24]))", path], { timeout: 5000 });
  const [width, height] = raw.split(" ").map(Number);
  if (!width || !height || Math.max(width, height) > PAGE_SIZE) throw new Error("Invalid preview dimensions");
  return { width, height };
}

export async function loadImagePreview(source, format, on, fetchOriginal) {
  const relative = CACHE + "/" + Date.now() + "-" + (++sequence) + "-" + Math.random().toString(36).slice(2);
  const asset = relative + ".png", absolute = appHome() + "/" + asset;
  await cacheDirectory(appHome() + "/" + CACHE);
  const decodeLocal = async source => {
    if (format.kind === "pdf") return renderImage(source, absolute, "pdf", null);
    try { await windowsImage(source, absolute); }
    catch {
      await releasePreview(absolute);
      await renderImage(source, absolute, "image", null);
    }
  };
  try {
    if (!on && windows()) {
      await decodeLocal(source);
    } else {
      try { await renderImage(source, absolute, format.kind, on); }
      catch (error) {
        if (!on || !windows()) throw error;
        // Windows can preview common formats even when the remote has no tools.
        // Bound the original so a fallback cannot download a huge file.
        const size = await command("python3", ["-c", "import os,sys; p=sys.argv[1]; assert os.path.isfile(p); print(os.path.getsize(p))", source], { on, timeout: 10000 });
        if (!/^\d+$/.test(size) || Number(size) > 64 * 1024 * 1024) throw error;
        const original = appHome() + "/" + relative + ".source." + format.ext;
        await releasePreview(absolute);
        try {
          await fetchOriginal(original);
          await decodeLocal(original);
        }
        finally { await releasePreview(original); }
      }
    }
    return { asset, absolute, ...await dimensions(absolute) };
  } catch (error) {
    await releasePreview(absolute);
    throw error;
  }
}

export function parseTable(text, separator) {
  const rows = [];
  let row = [], cell = "", quoted = false, started = false, truncated = false;
  const commitCell = () => {
    if (row.length < 24) row.push(cell);
    else truncated = true;
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && (quoted || !cell)) {
      started = true;
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === separator) {
      commitCell();
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      commitCell();
      rows.push(row);
      row = [];
      started = false;
      if (rows.length === 150 && i + 1 < text.length) return { rows, truncated: true };
    } else if (cell.length < 500) {
      cell += char;
    } else {
      truncated = true;
    }
  }
  if (row.length || cell || started) { commitCell(); rows.push(row); }
  return { rows, truncated: truncated || quoted };
}

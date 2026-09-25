import path from "path"
import { createHash } from "crypto"
import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"

// Omniwork's managed Python: a uv-provisioned standalone CPython plus a venv with the document and data
// libraries the work agent and its skills rely on. The desktop app bundles uv (AGENTOS_UV_PATH); the CLI
// uses uv from PATH when present and otherwise leaves the agent on system python as before.

// A minor version, not a patch: any uv (bundled or an older one on PATH) resolves it to the newest 3.12 it knows.
export const PYTHON = "3.12"
// Resolve transitive dependencies as of this instant so every install of a stamp gets the same packages.
export const EXCLUDE_NEWER = "2026-09-24T00:00:00Z"
export const REQUIREMENTS = [
  "pandas==3.0.6",
  "numpy==2.5.3",
  "openpyxl==3.1.5",
  "xlsxwriter==3.2.9",
  "pypdf==6.19.0",
  "pdfplumber==0.11.10",
  "python-docx==1.2.0",
  "python-pptx==1.0.2",
  "reportlab==5.0.1",
  "matplotlib==3.11.2",
  "markitdown[docx,pdf,pptx,xlsx]==0.1.8",
  "pillow==12.3.0",
]
// Import names verified after install; also warms matplotlib's font cache so the first chart is fast.
const IMPORTS =
  "import pandas, numpy, openpyxl, xlsxwriter, pypdf, pdfplumber, docx, pptx, reportlab, markitdown, PIL, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot"
const LAYOUT = 1
const RETRY_MS = 10 * 60_000

export type Status =
  | { state: "ready"; python: string; bin: string; version: string; current: boolean }
  | { state: "installing" }
  | { state: "failed"; log: string }
  | { state: "unavailable" }

type Current = { stamp: string; python: string; bin: string; version: string; installedAt: string }

export function stamp(input = { python: PYTHON, requirements: REQUIREMENTS, excludeNewer: EXCLUDE_NEWER }) {
  return createHash("sha256")
    .update(JSON.stringify({ layout: LAYOUT, ...input, requirements: input.requirements.toSorted() }))
    .digest("hex")
    .slice(0, 16)
}

export function root() {
  return path.join(Global.Path.data, "work-runtime")
}

// Display names for the prompt: "markitdown[docx,pdf,pptx,xlsx]==0.1.8" -> "markitdown".
export function packages() {
  return REQUIREMENTS.map((item) => item.split(/[[=<>]/)[0])
}

function disabled() {
  return process.env.OPENCODE_DISABLE_WORK_PYTHON === "1" || process.env.OPENCODE_DISABLE_WORK_PYTHON === "true"
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

async function uv() {
  const bundled = process.env.AGENTOS_UV_PATH
  if (bundled && (await exists(bundled))) return bundled
  return Bun.which("uv") ?? undefined
}

async function current(): Promise<Current | undefined> {
  const value = await Bun.file(path.join(root(), "current.json"))
    .json()
    .catch(() => undefined)
  if (!value || typeof value.python !== "string" || !(await exists(value.python))) return
  return value
}

let running: Promise<void> | undefined
let failed: { at: number; log: string } | undefined

export async function status(): Promise<Status> {
  const found = await current()
  if (found)
    return {
      state: "ready",
      python: found.python,
      bin: found.bin,
      version: found.version,
      current: found.stamp === stamp(),
    }
  if (running) return { state: "installing" }
  if (failed) return { state: "failed", log: failed.log }
  if (disabled() || !(await uv())) return { state: "unavailable" }
  return { state: "installing" }
}

// Idempotent and safe to call on every Work prompt or shell command: starts at most one background
// provision per process, and the on-disk lock keeps separate processes (desktop server, CLI) from racing.
export function ensure() {
  if (running) return running
  if (disabled()) return Promise.resolve()
  if (failed && Date.now() - failed.at < RETRY_MS) return Promise.resolve()
  running = (async () => {
    if ((await current())?.stamp === stamp()) return
    const binary = await uv()
    if (!binary) return
    await provision(binary)
    failed = undefined
  })()
    .catch((error) => {
      failed = { at: Date.now(), log: path.join(root(), "install.log") }
      return appendFile(failed.log, `[${new Date().toISOString()}] failed: ${String(error)}\n`).catch(() => undefined)
    })
    .finally(() => {
      running = undefined
    })
  return running
}

async function provision(binary: string) {
  const dir = root()
  const log = path.join(dir, "install.log")
  const id = stamp()
  await mkdir(dir, { recursive: true })
  // Stale after a minute without a heartbeat, so a crashed installer never wedges later attempts.
  await using _ = await Flock.acquire("work-python", { dir: path.join(dir, "locks"), timeoutMs: 60 * 60_000 })
  // Another process may have finished while this one waited for the lock.
  if ((await current())?.stamp === id) return

  const started = Date.now()
  const write = (line: string) => appendFile(log, `[${new Date().toISOString()}] ${line}\n`)
  await write(`provisioning ${id} with ${binary}: python ${PYTHON}, ${REQUIREMENTS.join(" ")}`)
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      // Keep uv away from the user's configuration, global cache, and ~/.local/bin.
      UV_NO_CONFIG: "1",
      UV_CACHE_DIR: path.join(dir, "cache"),
      UV_PYTHON_INSTALL_DIR: path.join(dir, "python"),
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_NO_PROGRESS: "1",
    }).filter(([key]) => !["VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONHOME", "PYTHONPATH"].includes(key)),
  )
  const run = async (cmd: string[]) => {
    await write(`$ ${cmd.join(" ")}`)
    const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    await appendFile(log, out + err)
    if (code !== 0) throw new Error(`${path.basename(cmd[0])} ${cmd[1]} exited with ${code}`)
    return out + err
  }

  // Each stamp builds in its own folder; a partial folder from an interrupted run is rebuilt from uv's cache.
  const envDir = path.join(dir, "envs", id)
  const bin = path.join(envDir, process.platform === "win32" ? "Scripts" : "bin")
  const python = path.join(bin, process.platform === "win32" ? "python.exe" : "python")
  const requirements = path.join(dir, `requirements-${id}.txt`)
  await writeFile(requirements, REQUIREMENTS.join("\n") + "\n")
  await run([binary, "python", "install", PYTHON, "--no-bin"])
  await run([binary, "venv", "--seed", "--clear", "--python", PYTHON, envDir])
  await run([binary, "pip", "install", "--python", python, "--exclude-newer", EXCLUDE_NEWER, "-r", requirements])
  await run([python, "-c", IMPORTS])
  const version = (await run([python, "--version"])).trim().replace(/^Python /, "")

  const next: Current = { stamp: id, python, bin, version, installedAt: new Date().toISOString() }
  await writeFile(path.join(dir, "current.json.tmp"), JSON.stringify(next, null, 2))
  await rename(path.join(dir, "current.json.tmp"), path.join(dir, "current.json"))
  await write(`ready ${id} in ${Math.round((Date.now() - started) / 1000)}s`)

  // Previous stamps' environments and the download cache are no longer needed.
  const stale = (await readdir(path.join(dir, "envs"))).filter((name) => name !== id)
  await Promise.all([
    ...stale.map((name) => rm(path.join(dir, "envs", name), { recursive: true, force: true })),
    rm(path.join(dir, "cache"), { recursive: true, force: true }),
    ...(await readdir(dir))
      .filter((name) => name.startsWith("requirements-") && name !== path.basename(requirements))
      .map((name) => rm(path.join(dir, name), { force: true })),
  ])
}

// Shell environment for Work sessions: the managed venv first on PATH so `python3`, `python`, and `pip`
// resolve to it. Other agents and a not-yet-ready runtime get the environment unchanged.
export function env(base: NodeJS.ProcessEnv, work: boolean, value: Status): NodeJS.ProcessEnv {
  if (!work || value.state !== "ready") return base
  const key = Object.keys(base).find((item) => item.toUpperCase() === "PATH") ?? "PATH"
  const next: NodeJS.ProcessEnv = {
    ...base,
    [key]: [value.bin, base[key]].filter(Boolean).join(path.delimiter),
    VIRTUAL_ENV: path.dirname(value.bin),
    // Scripts save charts to files; never try to open a GUI window from the agent's shell.
    MPLBACKEND: "Agg",
  }
  delete next.PYTHONHOME
  return next
}

export function describe(value: Status) {
  if (value.state === "ready") {
    return [
      `Python: \`python3\` in the shell is ${value.python} (Python ${value.version}) with ${packages().join(", ")} preinstalled.`,
      "Do not pip install these. Only install something else if an import fails; `pip install` goes into this environment.",
    ].join(" ")
  }
  if (value.state === "installing") {
    return "Python: the managed Python tools (pandas, openpyxl, pypdf, python-docx, python-pptx, matplotlib, and more) are still installing in the background, usually for a minute or two. Use system python3 if needed, or check again shortly."
  }
  if (value.state === "failed") {
    return `Python: the managed Python tools failed to install (log: ${value.log}). Use system python3 and install missing packages only when an import fails.`
  }
}

// System prompt section for Work sessions; also starts provisioning on first use.
export async function prompt() {
  void ensure()
  const text = describe(await status())
  return text && `<python>\n${text}\n</python>`
}

export * as WorkPython from "./python"

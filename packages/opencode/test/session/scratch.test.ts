import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Scratch } from "../../src/session/scratch"

const exists = (file: string) => fs.stat(file).then(
  () => true,
  () => false,
)

test("creating a scratch folder sweeps folders idle for over a week and keeps recent ones", async () => {
  const stale = path.join(Scratch.root, "ses_stale")
  const recent = path.join(Scratch.root, "ses_recent")
  await fs.mkdir(path.join(stale, "render"), { recursive: true })
  await fs.mkdir(recent, { recursive: true })
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await fs.utimes(stale, old, old)

  const dir = await Scratch.ensure("ses_fresh")
  expect(dir).toBe(path.join(Scratch.root, "ses_fresh"))
  expect((await fs.stat(dir)).isDirectory()).toBe(true)

  expect(await exists(stale)).toBe(false)
  expect(await exists(recent)).toBe(true)

  // Reusing an existing folder touches it so an active session is never swept.
  await fs.utimes(recent, old, old)
  await Scratch.ensure("ses_recent")
  expect((await fs.stat(recent)).mtimeMs).toBeGreaterThan(old.getTime())
})

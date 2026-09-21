#!/usr/bin/env bun
import { $ } from "bun"
import { mkdir, readFile } from "node:fs/promises"
import sharp from "sharp"

const source = await readFile("icons/agentos.svg")
const directory = "resources/icons/AgentOS.iconset"
await mkdir(directory, { recursive: true })
await sharp(source).png().toFile("resources/icons/dock.png")
await sharp(source).png().toFile("resources/icons/icon.png")
for (const size of [16, 32, 128, 256, 512]) {
  await sharp(source).resize(size, size).png().toFile(`${directory}/icon_${size}x${size}.png`)
  await sharp(source).resize(size * 2, size * 2).png().toFile(`${directory}/icon_${size}x${size}@2x.png`)
}
await $`iconutil -c icns ${directory} -o resources/icons/icon.icns`

import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./present_files.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  paths: Schema.Array(Schema.String).check(Schema.isLengthBetween(1, 10)).annotate({
    description: "Files to show the user, absolute or relative to the project directory (1 to 10 paths)",
  }),
})

type Metadata = {
  files: Array<{ path: string; name: string }>
}

export const PresentFilesTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service>(
  "present_files",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const files = yield* Effect.forEach(
            params.paths,
            Effect.fnUntraced(function* (item) {
              const full = path.isAbsolute(item) ? item : path.resolve(instance.directory, item)
              const filepath = process.platform === "win32" ? FSUtil.normalizePath(full) : full
              if (yield* fs.existsSafe(filepath)) return { path: filepath, name: path.basename(filepath) }
              // Long absolute paths get mistyped. When the file is missing, fall back to the one file in the
              // project with the same name, before any permission check can fire on the mistyped path.
              const matches = yield* Effect.promise(() =>
                Array.fromAsync(
                  new Bun.Glob(`**/${path.basename(filepath).replace(/[[\]{}()*?!\\]/g, "\\$&")}`).scan({
                    cwd: instance.directory,
                    absolute: true,
                    onlyFiles: true,
                  }),
                ),
              )
              const match = matches.filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`))
              if (match.length === 1) return { path: match[0], name: path.basename(match[0]) }
              return { path: filepath, name: path.basename(filepath) }
            }),
          )

          // Permission checks come before any stat so paths outside the project are not probed unasked.
          yield* Effect.forEach(files, (file) => assertExternalDirectoryEffect(ctx, file.path, { read: true }), {
            discard: true,
          })

          yield* ctx.ask({
            permission: "present_files",
            patterns: files.map((file) => path.relative(instance.worktree, file.path)),
            always: ["*"],
            metadata: {},
          })

          const missing = yield* Effect.forEach(
            files,
            Effect.fnUntraced(function* (file) {
              const stat = yield* fs.stat(file.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!stat) return [`File not found: ${file.path}`]
              if (stat.type !== "File") return [`Not a regular file: ${file.path}`]
              return []
            }),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((items) => items.flat()))
          if (missing.length > 0) return yield* Effect.fail(new Error(missing.join("\n")))

          const names = files.map((file) => file.name).join(", ")
          return {
            title: names,
            output: `Shown to the user in the app: ${names}`,
            metadata: { files },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

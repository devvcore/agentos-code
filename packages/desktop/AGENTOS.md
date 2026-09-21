# AgentOS Code desktop preview

The Electron app and CLI share the AgentOS Code login. Desktop bundles its own
compiled CLI, starts it on authenticated loopback, and opens browser sign-in when
no valid account exists. Model access and usage use the AgentOS inference service.
Settings → AgentOS account shows the current workspace and credits. Signing out
revokes the shared login and quits the desktop app.

This is a separate application from AgentOS Desktop: its bundle identifier and
desktop storage are `net.tryagentos.code`. Coding sessions use the same runtime
storage as the AgentOS Code CLI. OpenCode provider onboarding, migration, remote
servers, WSL, telemetry upload, and upstream automatic updates are not enabled.

## Build on Apple Silicon macOS

From this package, with Bun 1.3.14 installed:

```sh
bun run build:agentos
bun run typecheck
bun test src/main/agentos-runtime.test.ts src/main/index.test.ts src/renderer/initialization.test.ts
AGENTOS_ALLOW_ADHOC=1 bun run package:agentos --dir
open 'dist-agentos/mac-arm64/AgentOS Code.app'
```

The default version is `0.2.0-preview.1`; set `AGENTOS_VERSION` consistently for
both build and package commands to override it. Local builds are ad-hoc signed
for development on the build computer. They are not notarized public releases.

For distribution, omit `AGENTOS_ALLOW_ADHOC`, set `CSC_NAME` to the full Developer
ID Application identity, configure electron-builder's Apple notarization
credentials, and run `bun run package:agentos`. Preserve the MIT license and
upstream notices. Publish only after testing the signed artifact on a clean Mac.

Automatic updating remains disabled until an AgentOS-owned signed release feed
is configured. The public CLI installer at `/code/install.sh` continues to serve
the stable CLI independently of this desktop preview.

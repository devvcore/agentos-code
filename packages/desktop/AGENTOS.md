# OmniCode desktop

The Electron app and CLI share the OmniCode login. Desktop bundles its own
compiled CLI, starts it on authenticated loopback, and opens browser sign-in when
no valid account exists. Model access and usage use the AgentOS inference service.
Settings → AgentOS account shows the current workspace and credits. Signing out
revokes the shared login and quits the desktop app.

This is a separate application from AgentOS Desktop: its bundle identifier and
desktop storage are `net.tryagentos.code`. Coding sessions use the same runtime
storage as the OmniCode CLI. OpenCode provider onboarding, migration, remote
servers, WSL, telemetry upload, and upstream automatic updates are not enabled.

## Prompt dictation

The microphone records up to five minutes and inserts the transcript into the current draft for review. It never sends the prompt. Cancelling or switching sessions discards the recording and releases the microphone. Audio is sent through the saved AgentOS account to `/api/desktop/dictation?reconcile_tasks=false`, using the existing transcription and workspace-credit path.

The prompt uses the actual MIT-licensed `voice-glow` and `border-beam` packages from Libraries.dev through a small React root inside the Solid composer. Their license ships in the app resources.

## GPT Live

The waveform button starts a spoken conversation through the existing AgentOS
account and workspace credits. The composer becomes the call controls, with the
same Libraries.dev VoiceBeam responding to microphone and assistant audio. The
Voice tab beside Review shows both sides in the existing resizable panel.

Mute the microphone, then hold Space to talk and release to mute again. Space
keeps its normal behavior in text fields and on focused controls. Losing focus
or hiding the app also releases push-to-talk. “Type a message” sends text through
the same coding session during the call; unsent text returns to the draft when
the call ends.

Spoken and typed requests use ordinary prompt admission and existing approvals.
The coding agent runs independently while GPT Live continues talking; ending a
call stops its audio and usage, not the coding run. Credentials stay in a private
CLI bridge process, and the renderer receives only call lifecycle results.

## Build on Apple Silicon macOS

From this package, with Bun 1.3.14 installed:

```sh
bun run build:agentos
bun run typecheck
bun test src/main/agentos-runtime.test.ts src/main/index.test.ts src/renderer/initialization.test.ts
AGENTOS_ALLOW_ADHOC=1 bun run package:agentos --dir
open 'dist-agentos/mac-arm64/OmniCode.app'
```

The default version is `0.2.0-preview.1`; set `AGENTOS_VERSION` consistently for
both build and package commands to override it. Local builds are ad-hoc signed
for development on the build computer. They are not notarized public releases.

For distribution, omit `AGENTOS_ALLOW_ADHOC`, set `CSC_NAME` to the Developer ID
Application identity name, configure electron-builder's Apple notarization
credentials, and run `bun run package:agentos`. The optional
`Developer ID Application:` prefix is normalized before electron-builder receives
the name. Preserve the MIT license and upstream notices. Publish only after
testing the signed artifact on a clean Mac.

Automatic updating remains disabled until an AgentOS-owned signed release feed
is configured. The public CLI installer at `/code/install.sh` continues to serve
the stable CLI independently of the desktop app.

import type { Message, Session, Part, SnapshotFileDiff, SessionStatus, Provider } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, Provider>
  defaultModel?: {
    providerID: string
    modelID: string
  } | null
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: (SnapshotFileDiff | FileDiffInfo)[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export const {
  use: useData,
  provider: DataProvider,
  optional: useOptionalData,
} = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    sessionID?: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    // Omniwork Work mode: tool parts render friendly file lines instead of diffs
    workMode?: boolean
    // Omniwork Work mode: opens a deliverable (absolute path) in the side panel preview
    onOpenFile?: (path: string) => void
    // Resolves a local markdown image source to a displayable (data/blob) URL, or undefined when not allowed
    resolveImage?: (src: string) => Promise<string | undefined>
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      get sessionID() {
        return props.sessionID
      },
      get workMode() {
        return props.workMode ?? false
      },
      get openFile() {
        return props.onOpenFile
      },
      get resolveImage() {
        return props.resolveImage
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
    }
  },
})

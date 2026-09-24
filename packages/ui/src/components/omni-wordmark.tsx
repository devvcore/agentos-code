import { Show } from "solid-js"

// OpenCode's wordmark is drawn on a square grid. Preserve its glyph geometry
// for the shared letters and construct m/i (and w/r/k for "work") with the same stroke and spacing.
// "omnicode" is 39 units wide; "omniwork" is 41.
export function OmniWordmarkPaths(props: { variant?: "code" | "work" }) {
  return (
    <g fill="currentColor" fill-rule="evenodd">
      <path d="M0 1H4V6H0ZM1 2V5H3V2Z" />
      <path d="M5 1H11V2H12V6H11V2H9V6H8V2H6V6H5Z" />
      <path d="M13 1H16V2H14V6H13ZM16 2H17V6H16Z" />
      <path d="M18 0H19V1H18ZM18 2H19V6H18Z" />
      <Show
        when={props.variant === "work"}
        fallback={
          <>
            <path d="M20 1H24V2H21V5H24V6H20Z" />
            <path d="M25 1H29V6H25ZM26 2V5H28V2Z" />
            <path d="M33 0H34V6H30V1H33ZM31 2V5H33V2Z" />
            <path d="M35 1H39V4H36V5H39V6H35ZM36 2V3H38V2Z" />
          </>
        }
      >
        <path d="M20 1H21V5H23V1H24V5H26V6H20ZM26 1H27V5H26Z" />
        <path d="M28 1H32V6H28ZM29 2V5H31V2Z" />
        <path d="M33 1H36V2H34V6H33Z" />
        <path d="M37 0H38V6H37ZM38 3H40V4H38ZM40 1H41V3H40ZM40 4H41V6H40Z" />
      </Show>
    </g>
  )
}

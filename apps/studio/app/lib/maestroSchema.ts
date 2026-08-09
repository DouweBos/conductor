/**
 * The Maestro flow vocabulary, transcribed from the YAML models in the Maestro
 * source (`YamlFluentCommand` and the `Yaml*` command classes) rather than from
 * the docs, so the names match what the parser actually accepts. Conductor runs
 * a subset of these; `conductorOnly` marks the ones it adds.
 */

export interface ParamDef {
  name: string;
  detail?: string;
}

export interface CommandDef {
  name: string;
  doc: string;
  /** Keys accepted in the command's block form. */
  params: ParamDef[];
  /** Takes an element selector, so it also accepts every selector key. */
  selector?: boolean;
}

/** Keys any element selector accepts (YamlElementSelector). */
export const SELECTOR_PARAMS: ParamDef[] = [
  { name: "text", detail: "match by visible text (regex)" },
  { name: "id", detail: "match by accessibility id / resource id" },
  { name: "index", detail: "nth match, 0-based" },
  { name: "point", detail: '"50%,50%" or "100,200"' },
  { name: "label", detail: "step label shown in the report" },
  { name: "optional", detail: "don't fail when it isn't found" },
  { name: "enabled", detail: "match by enabled state" },
  { name: "selected", detail: "match by selected state" },
  { name: "checked", detail: "match by checked state" },
  { name: "focused", detail: "match by focus state" },
  { name: "below", detail: "element below this one" },
  { name: "above", detail: "element above this one" },
  { name: "leftOf", detail: "element left of this one" },
  { name: "rightOf", detail: "element right of this one" },
  { name: "childOf", detail: "element inside this one" },
  { name: "containsChild", detail: "has this direct child" },
  { name: "containsDescendants", detail: "has all of these descendants" },
  { name: "width", detail: "match by width" },
  { name: "height", detail: "match by height" },
  { name: "tolerance", detail: "size match tolerance" },
  { name: "traits", detail: "accessibility traits" },
  { name: "css", detail: "web only: CSS selector" },
  { name: "repeat", detail: "repeat the action n times" },
  { name: "delay", detail: "delay between repeats, ms" },
  { name: "retryTapIfNoChange", detail: "retry when the screen doesn't change" },
  { name: "waitUntilVisible", detail: "wait for it before acting" },
  { name: "waitToSettleTimeoutMs", detail: "settle timeout after the action" },
];

const LABEL: ParamDef[] = [
  { name: "label", detail: "step label shown in the report" },
  { name: "optional", detail: "don't fail this step" },
];

export const COMMANDS: CommandDef[] = [
  { name: "tapOn", doc: "Tap an element", params: [], selector: true },
  { name: "doubleTapOn", doc: "Double-tap an element", params: [], selector: true },
  { name: "longPressOn", doc: "Press and hold an element", params: [], selector: true },
  { name: "assertVisible", doc: "Fail unless the element is visible", params: [], selector: true },
  { name: "assertNotVisible", doc: "Fail if the element is visible", params: [], selector: true },
  { name: "copyTextFrom", doc: "Copy an element's text into the clipboard", params: [], selector: true },
  {
    name: "assertTrue",
    doc: "Fail unless the expression is true",
    params: [{ name: "condition", detail: "JS expression" }, ...LABEL],
  },
  {
    name: "launchApp",
    doc: "Launch the app under test",
    params: [
      { name: "appId", detail: "bundle id / package name" },
      { name: "clearState", detail: "DESTRUCTIVE: wipes app data and sign-in" },
      { name: "clearKeychain", detail: "DESTRUCTIVE: wipes the device keychain" },
      { name: "stopApp", detail: "stop before launching (default true)" },
      { name: "permissions", detail: "permission -> allow/deny" },
      { name: "arguments", detail: "launch arguments" },
      ...LABEL,
    ],
  },
  { name: "stopApp", doc: "Stop the app", params: [{ name: "appId" }, ...LABEL] },
  { name: "killApp", doc: "Kill the app process", params: [{ name: "appId" }, ...LABEL] },
  {
    name: "clearState",
    doc: "DESTRUCTIVE: wipe app data and sign-in state",
    params: [{ name: "appId" }, ...LABEL],
  },
  { name: "clearKeychain", doc: "DESTRUCTIVE: wipe the device keychain", params: LABEL },
  {
    name: "inputText",
    doc: "Type into the focused field",
    params: [{ name: "text" }, ...LABEL],
  },
  { name: "inputRandomText", doc: "Type random text", params: [{ name: "length" }, ...LABEL] },
  { name: "inputRandomNumber", doc: "Type a random number", params: [{ name: "length" }, ...LABEL] },
  { name: "inputRandomEmail", doc: "Type a random email", params: LABEL },
  { name: "inputRandomPersonName", doc: "Type a random name", params: LABEL },
  { name: "eraseText", doc: "Delete characters from the field", params: [{ name: "charactersToErase" }, ...LABEL] },
  { name: "pasteText", doc: "Paste the clipboard into the field", params: LABEL },
  { name: "hideKeyboard", doc: "Dismiss the keyboard", params: LABEL },
  { name: "back", doc: "Navigate back", params: LABEL },
  {
    name: "pressKey",
    doc: "Press a hardware or remote key",
    params: [{ name: "key", detail: "Home, Back, Enter, Remote Dpad Center, …" }, ...LABEL],
  },
  {
    name: "swipe",
    doc: "Swipe across the screen",
    params: [
      { name: "direction", detail: "UP / DOWN / LEFT / RIGHT" },
      { name: "start", detail: '"50%,80%"' },
      { name: "end", detail: '"50%,20%"' },
      { name: "from", detail: "swipe from an element" },
      { name: "duration", detail: "milliseconds" },
      ...LABEL,
    ],
  },
  { name: "scroll", doc: "Scroll down one screen", params: LABEL },
  {
    name: "scrollUntilVisible",
    doc: "Scroll until an element appears",
    params: [
      { name: "element", detail: "selector to look for" },
      { name: "direction", detail: "UP / DOWN / LEFT / RIGHT" },
      { name: "timeout", detail: "milliseconds" },
      { name: "speed", detail: "0–100" },
      { name: "visibilityPercentage", detail: "how much must be on screen" },
      { name: "centerElement", detail: "center it when found" },
      ...LABEL,
    ],
  },
  {
    name: "extendedWaitUntil",
    doc: "Wait for an element to appear or disappear",
    params: [
      { name: "visible", detail: "selector to wait for" },
      { name: "notVisible", detail: "selector to wait to disappear" },
      { name: "timeout", detail: "milliseconds" },
      ...LABEL,
    ],
  },
  { name: "waitForAnimationToEnd", doc: "Wait for animations to settle", params: [{ name: "timeout" }, ...LABEL] },
  {
    name: "runFlow",
    doc: "Run a subflow, optionally conditionally",
    params: [
      { name: "file", detail: "path to the subflow" },
      { name: "env", detail: "parameters passed to it" },
      { name: "when", detail: "visible / notVisible / true" },
      { name: "commands", detail: "inline steps instead of a file" },
      ...LABEL,
    ],
  },
  {
    name: "runScript",
    doc: "Run a JavaScript file",
    params: [{ name: "file" }, { name: "env" }, ...LABEL],
  },
  { name: "evalScript", doc: "Evaluate a JavaScript expression", params: [{ name: "script" }, ...LABEL] },
  { name: "repeat", doc: "Repeat steps", params: [{ name: "times" }, { name: "while" }, { name: "commands" }, ...LABEL] },
  { name: "retry", doc: "Retry steps on failure", params: [{ name: "maxRetries" }, { name: "commands" }, ...LABEL] },
  {
    name: "takeScreenshot",
    doc: "Save a screenshot",
    params: [{ name: "path" }, { name: "cropOn", detail: "crop to an element" }, ...LABEL],
  },
  {
    name: "assertScreenshot",
    doc: "Compare against a baseline screenshot",
    params: [{ name: "path" }, { name: "thresholdPercentage" }, { name: "cropOn" }, ...LABEL],
  },
  { name: "startRecording", doc: "Start screen recording", params: [{ name: "path" }, ...LABEL] },
  { name: "stopRecording", doc: "Stop screen recording", params: LABEL },
  {
    name: "openLink",
    doc: "Open a deep link or URL",
    params: [{ name: "link" }, { name: "browser" }, { name: "autoVerify" }, ...LABEL],
  },
  {
    name: "setLocation",
    doc: "Set the device location",
    params: [{ name: "latitude" }, { name: "longitude" }, ...LABEL],
  },
  { name: "setOrientation", doc: "Rotate the device", params: [{ name: "orientation" }, ...LABEL] },
  { name: "setClipboard", doc: "Put text on the clipboard", params: [{ name: "text" }, ...LABEL] },
  {
    name: "setPermissions",
    doc: "Grant or deny app permissions",
    params: [{ name: "appId" }, { name: "permissions" }, ...LABEL],
  },
  { name: "setAirplaneMode", doc: "Turn airplane mode on or off", params: [{ name: "value" }, ...LABEL] },
  { name: "toggleAirplaneMode", doc: "Flip airplane mode", params: LABEL },
  { name: "addMedia", doc: "Push media files onto the device", params: [{ name: "files" }, ...LABEL] },
  { name: "travel", doc: "Simulate movement between points", params: [{ name: "points" }, { name: "speed" }, ...LABEL] },
];

/** Keys allowed in the header document, above the `---`. */
export const HEADER_KEYS: ParamDef[] = [
  { name: "appId", detail: "bundle id / package name under test" },
  { name: "name", detail: "flow name in reports" },
  { name: "tags", detail: "tags for --include-tags / --exclude-tags" },
  { name: "env", detail: "default values for this flow's parameters" },
  { name: "onFlowStart", detail: "steps to run before the flow" },
  { name: "onFlowComplete", detail: "steps to run after the flow" },
];

export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** Every key a command accepts, selector keys included. */
export function paramsFor(command: CommandDef): ParamDef[] {
  return command.selector ? [...SELECTOR_PARAMS, ...command.params] : command.params;
}

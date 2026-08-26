import { propertiesOf, testCaseIdsOf, withTestCaseIds } from "../electron/services/flow/properties";
import { assert, assertEqual, TestSuite } from "./runner";

export const flowProperties = new TestSuite("Flow properties");

const FLOW = `appId: \${APP_ID}
name: Login with valid credentials
tags:
  - mobile
properties:
  testCaseId: "MC-12"
  priority: High
---
- launchApp
- tapOn: "Sign in"
`;

flowProperties.test("reads Maestro's custom properties off the header", () => {
  assertEqual(propertiesOf(FLOW), { testCaseId: "MC-12", priority: "High" }, "both properties");
  assertEqual(testCaseIdsOf(FLOW), ["MC-12"], "the case it covers");
});

flowProperties.test("a flow may cover more than one case", () => {
  const flow = FLOW.replace('"MC-12"', '"MC-12, MC-13"');
  assertEqual(testCaseIdsOf(flow), ["MC-12", "MC-13"], "both refs");
});

flowProperties.test("a flow with no properties covers nothing", () => {
  assertEqual(testCaseIdsOf("appId: com.example\n---\n- launchApp\n"), [], "no refs");
  assertEqual(testCaseIdsOf("- launchApp\n"), [], "not even a header");
});

flowProperties.test("linking keeps the rest of the flow byte-identical", () => {
  const source = `# Login\nappId: com.example\ntags:\n  - mobile\n---\n- launchApp\n`;
  const linked = withTestCaseIds(source, ["MC-12"]);

  assertEqual(testCaseIdsOf(linked), ["MC-12"], "the link landed");
  assert(linked.startsWith("# Login\n"), "the header comment survived");
  assert(linked.endsWith("---\n- launchApp\n"), "the body is untouched");
  assert(linked.includes("tags:\n  - mobile"), "and so are the tags");
});

flowProperties.test("re-linking replaces the ref rather than appending a second", () => {
  const relinked = withTestCaseIds(FLOW, ["MC-99"]);
  assertEqual(testCaseIdsOf(relinked), ["MC-99"], "one ref, the new one");
  assertEqual(propertiesOf(relinked).priority, "High", "other properties are left alone");
});

flowProperties.test("unlinking drops the property, and the block when it empties", () => {
  const unlinked = withTestCaseIds(FLOW, []);
  assertEqual(testCaseIdsOf(unlinked), [], "no case");
  assertEqual(propertiesOf(unlinked), { priority: "High" }, "the other property stays");

  const only = `appId: com.example\nproperties:\n  testCaseId: "MC-12"\n---\n- launchApp\n`;
  assert(!withTestCaseIds(only, []).includes("properties:"), "an empty properties block is removed");
});

flowProperties.test("a flow with no header at all gets one", () => {
  const linked = withTestCaseIds("- launchApp\n", ["MC-12"]);
  assertEqual(testCaseIdsOf(linked), ["MC-12"], "the link landed");
  assert(linked.includes("- launchApp"), "the body survived");
});

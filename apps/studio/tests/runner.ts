/**
 * Minimal test runner — same shape as the CLI's, no dependencies.
 * Run with `pnpm test` (tsx, so no build step).
 */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new AssertionError(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

type Case = { name: string; fn: () => Promise<void> | void };

export class TestSuite {
  private cases: Case[] = [];

  constructor(public readonly name: string) {}

  test(name: string, fn: () => Promise<void> | void): void {
    this.cases.push({ name, fn });
  }

  async run(): Promise<{ passed: number; failed: number; failures: string[] }> {
    const GREEN = "\x1b[32m";
    const RED = "\x1b[31m";
    const BOLD = "\x1b[1m";
    const NC = "\x1b[0m";
    let passed = 0;
    let failed = 0;
    const failures: string[] = [];

    console.log(`\n${BOLD}▶ ${this.name}${NC}`);
    for (const { name, fn } of this.cases) {
      try {
        await fn();
        passed++;
        console.log(`  ${GREEN}✓${NC} ${name}`);
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${this.name} / ${name}: ${message}`);
        console.log(`  ${RED}✗${NC} ${name}`);
        console.log(`    ${RED}${message}${NC}`);
      }
    }
    return { passed, failed, failures };
  }
}

export async function runAll(suites: TestSuite[]): Promise<void> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const suite of suites) {
    const result = await suite.run();
    passed += result.passed;
    failed += result.failed;
    failures.push(...result.failures);
  }
  console.log(`\n${"─".repeat(50)}`);
  console.log(failed ? `\x1b[31m\x1b[1m${failed} failed\x1b[0m  ${passed} passed` : `\x1b[32m\x1b[1m${passed} passed\x1b[0m`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  • ${failure}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

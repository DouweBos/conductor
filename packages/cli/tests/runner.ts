/**
 * Minimal test runner — no dependencies.
 *
 * Usage:
 *   const t = new TestRunner('My Suite');
 *   t.test('does something', async () => { ... throw new Error('fail msg') ... });
 *   await t.run();
 */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

type TestCase = { name: string; fn: () => Promise<void> };

export class TestSuite {
  private cases: TestCase[] = [];

  constructor(public readonly name: string) {}

  test(name: string, fn: () => Promise<void>): void {
    this.cases.push({ name, fn });
  }

  async run(): Promise<{ passed: number; failed: number; failures: string[] }> {
    const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', NC = '\x1b[0m';
    let passed = 0, failed = 0;
    const failures: string[] = [];

    console.log(`\n${BOLD}▶ ${this.name}${NC}`);

    for (const { name, fn } of this.cases) {
      try {
        await fn();
        console.log(`  ${GREEN}✓${NC} ${name}`);
        passed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${RED}✗${NC} ${name}`);
        console.log(`    ${RED}${msg}${NC}`);
        failed++;
        failures.push(`${this.name} / ${name}: ${msg}`);
      }
    }

    return { passed, failed, failures };
  }
}

export async function runAll(suites: TestSuite[]): Promise<void> {
  const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', NC = '\x1b[0m';
  let totalPassed = 0, totalFailed = 0;
  const allFailures: string[] = [];

  for (const suite of suites) {
    const { passed, failed, failures } = await suite.run();
    totalPassed += passed;
    totalFailed += failed;
    allFailures.push(...failures);
  }

  console.log(`\n${'─'.repeat(50)}`);
  if (totalFailed === 0) {
    console.log(`${GREEN}${BOLD}All ${totalPassed} tests passed.${NC}`);
  } else {
    console.log(`${RED}${BOLD}${totalFailed} failed${NC}  ${totalPassed} passed`);
    console.log(`\nFailures:`);
    for (const f of allFailures) console.log(`  • ${f}`);
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

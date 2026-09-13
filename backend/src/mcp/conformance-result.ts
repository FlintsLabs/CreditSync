// Shared interpretation of the pinned runner's terminal summary. Kept apart
// from the executable fixture so its gate can be tested without a server.
export function evaluateConformanceResult(stdout: string, exitCode: number) {
    const match = stdout.match(/Passed:\s*(\d+)\/(\d+),\s*(\d+) failed,\s*(\d+) warnings/);
    const checks = match ? { passed: Number(match[1]), denominator: Number(match[2]), failed: Number(match[3]), warnings: Number(match[4]) } : null;
    const passed = exitCode === 0 && checks !== null
        && Object.values(checks).every(Number.isSafeInteger)
        && checks.denominator > 0 && checks.passed === checks.denominator && checks.failed === 0;
    return { checks, passed };
}

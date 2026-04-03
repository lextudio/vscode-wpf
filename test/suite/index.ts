export async function run(): Promise<void> {
  // Unit tests run first — no WPF app or pipe needed.
  const xamlDiffSuite = await import('./xamlDiff.unit');
  await xamlDiffSuite.run();

  const runtimeSuite = await import('./runtimeHotReload.integration');
  await runtimeSuite.run();

  if (process.env.WPF_SKIP_NETFX_TESTS !== '1') {
    const frameworkSuite = await import('./frameworkHotReload.integration');
    await frameworkSuite.run();
  }
}

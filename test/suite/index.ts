export async function run(): Promise<void> {
  const runtimeSuite = await import('./runtimeHotReload.integration');
  await runtimeSuite.run();

  const frameworkSuite = await import('./frameworkHotReload.integration');
  await frameworkSuite.run();
}

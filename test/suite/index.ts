export async function run(): Promise<void> {
  const suite = await import('./runtimeHotReload.integration');
  await suite.run();
}

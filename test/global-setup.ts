import { generateFixtures } from './fixture-gen.js';

/** vitest globalSetup: synthesize audio fixtures once per run (cached). */
export default async function setup(): Promise<void> {
  await generateFixtures();
}

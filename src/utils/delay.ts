/**
 * Generate a random delay between min and max milliseconds
 */
export function getRandomDelay(min: number = 1000, max: number = 3000): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for a random amount of time to simulate human behavior
 */
export async function randomDelay(): Promise<void> {
  const delay = getRandomDelay();
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Sleep for a specific amount of time
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

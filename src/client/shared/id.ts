/**
 * Generates a random UUID v4.
 */
export function randomUUID(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto.getRandomValues === 'function') {
      return '10000000-1000-4000-8000-100000000000'.replace(
        /[018]/g,
        (char) => {
          const num = Number(char);
          const randomByte = crypto.getRandomValues(new Uint8Array(1))[0];
          return (num ^ (randomByte & (15 >> (num / 4)))).toString(16);
        },
      );
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const randomByte = (Math.random() * 16) | 0;
    return (char === 'x' ? randomByte : (randomByte & 0x3) | 0x8).toString(16);
  });
}

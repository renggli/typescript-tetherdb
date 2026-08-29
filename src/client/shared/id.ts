const UUID_TEMPLATE = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';

/**
 * Generates a random UUID v4.
 */
export function randomUUID(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto.getRandomValues === 'function') {
      const buffer = new Uint8Array(1);
      return UUID_TEMPLATE.replace(/[xy]/g, (char) => {
        const randomByte = crypto.getRandomValues(buffer)[0] & 0xf;
        return (char === 'x' ? randomByte : (randomByte & 0x3) | 0x8).toString(
          16,
        );
      });
    }
  }
  return UUID_TEMPLATE.replace(/[xy]/g, (char) => {
    const randomByte = (Math.random() * 16) | 0;
    return (char === 'x' ? randomByte : (randomByte & 0x3) | 0x8).toString(16);
  });
}

/** Reads one message the bridge sent the phone. A binary frame carries its
 * details as a JSON header before the image; this returns that header. */
export function serverMessage(payload: string | Buffer): Record<string, any> {
  if (typeof payload === 'string') return JSON.parse(payload);
  const length = payload.readUInt32BE(0);
  return JSON.parse(payload.subarray(4, 4 + length).toString());
}

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { jpegFrames } from '../src/desktop';

const jpeg = (fill: number, length: number) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(length, fill), Buffer.from([0xff, 0xd9])]);

describe('splitting ffmpeg MJPEG output', () => {
  it('finds whole images however the output is chunked, including markers split across chunks', () => {
    const images = [jpeg(1, 5000), jpeg(2, 3), jpeg(3, 70_000)];
    const all = Buffer.concat([Buffer.from([0, 0xff]), ...images]);
    for (const size of [1, 2, 3, 7, 4096, 65_536, all.length]) {
      const stream = new PassThrough(); const found: Buffer[] = [];
      jpegFrames(stream, image => found.push(image));
      for (let at = 0; at < all.length; at += size) stream.emit('data', all.subarray(at, at + size));
      expect(found.map(image => image.toString('hex'))).toEqual(images.map(image => image.toString('hex')));
    }
  });
});

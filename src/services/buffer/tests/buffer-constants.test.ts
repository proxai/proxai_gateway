import { expect, test } from 'bun:test';

import {
  uploadBatchesShippedKey,
  uploadBytesShippedKey,
} from 'services/buffer/buffer.constants.ts';

test('uploadBatchesShippedKey returns dot-delimited key for source app', () => {
  expect(uploadBatchesShippedKey('my-app')).toBe('upload_batches_shipped_by_source.my-app');
  expect(uploadBatchesShippedKey('')).toBe('upload_batches_shipped_by_source.');
});

test('uploadBytesShippedKey returns dot-delimited key for source app', () => {
  expect(uploadBytesShippedKey('my-app')).toBe('upload_bytes_shipped_by_source.my-app');
  expect(uploadBytesShippedKey('')).toBe('upload_bytes_shipped_by_source.');
});

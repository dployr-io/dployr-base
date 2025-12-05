// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// Ambient module declarations for optional runtime dependencies.
// These packages are only required at runtime if the corresponding
// config backends are enabled (kv.type / storage.type).

declare module 'redis' {
  const value: any;
  export = value;
}

declare module '@upstash/redis' {
  export const Redis: any;
}

declare module '@aws-sdk/client-s3' {
  export const S3Client: any;
}

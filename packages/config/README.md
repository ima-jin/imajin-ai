# @ima-jin/config

Shared configuration for Imajin services — CORS, service routing, session config, handle validation, and route helpers.

## Install

```bash
npm install @ima-jin/config
```

## Usage

```ts
import { getServiceUrl, getPort, SERVICES } from '@ima-jin/config';
import { isValidHandle, normalizeHandleInput } from '@ima-jin/config';
import { corsHeaders, withCors } from '@ima-jin/config';
import { eventPath, profileUrl } from '@ima-jin/config';
```

## What's included

- **Services** — port mappings, URL builders, service definitions
- **CORS** — origin validation, headers, middleware
- **Session** — cookie config, session cookie helpers
- **Handles** — validation, normalization, reserved handle list
- **Routes** — type-safe path builders for all Imajin services

## Part of Imajin

[Imajin](https://imajin.ai) — sovereign technology infrastructure. Open source.

# Supertext Plugin Health (TypeScript)

Version reports, the API key check result and the reachability ping of Supertext plugins, for the [Supertext Plugin Health dashboard](https://github.com/Supertext/Commando-Center-Supertext-Translation). No dependencies; Node.js 18+ (also Deno and Bun).

Usage, concepts and bundling: [Plugin Health README](../README.md). Reference implementation: the other languages follow `src/index.ts` and `../spec/reporter.json`.

```bash
npm ci && npm run typecheck && npm test && npm run build
```

Lockfile: create or update it with npm 11 (`npx npm@11 install`); npm 10 fails resolving Vitest 5's optional peers (`edgesOut`). `npm ci` with npm 10 works.

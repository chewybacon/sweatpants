# Contributing

## TypeScript Guidelines

- Packages must include `development` exports pointing to `src/`
- Tsc-buildable workspaces must set `"composite": true`
- Bundler-based apps must keep `"noEmit": true`
- New workspace dependencies must add matching `tsconfig.json` references

# Symphony documentation

Use this directory as the contributor entry point. The root
[README](../README.md) explains the product and operator workflow; these documents
explain how to change the repository safely.

## Contributor guides

- [Architecture](ARCHITECTURE.md) — a just-in-time repository map, dependency and
  ownership boundaries, runtime flows, and a change-impact guide.
- [Development](DEVELOPMENT.md) — current toolchain setup, local servers, package
  names, targeted tests, worktrees, Playwright, and the exact CI gate.
- [Contributing](../CONTRIBUTING.md) — the short pull-request and packaging guide.

## Visual references

These images are used by the root README and are kept here with the contributor
documentation:

- [Dashboard, light theme](overview-light.png)
- [Dashboard, dark theme](overview-dark.png)
- [Issues dependency graph](issues-dependency-graph.png)

When behavior, repository ownership, or a validation command changes, update the
smallest relevant document in the same pull request. Treat source files and
checked-in configuration as authoritative when documentation and code disagree.

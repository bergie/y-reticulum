# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-09-21

### Changed

- Updated `@reticulum/core` and `@reticulum/node` to `^0.8.2`

## [0.1.1] - 2026-08-04

### Changed

- Updated `@reticulum/core` and `@reticulum/node` to `^0.6.0`

### Added

- Release automation

## [0.1.0] - 2026-08-01

### Added

- Initial release: Reticulum network transport connector for Yjs
- Document and awareness synchronization between peers over Reticulum Links
- Compressed resource support via `@digitaldefiance/bzip2-wasm`
- Reconnection handling with automatic re-establishment and re-syncing of dropped Links
- Periodic re-announces to ensure destination discoverability
- Tests running on Node, Deno, and Bun

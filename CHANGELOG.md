# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Stack presets for Python (FastAPI), PHP (Laravel), and C# (.NET).
- New `evaluate` CLI command for architectural quality analysis.
- Extended Web UI with features management, sidebar, and AI suggestions chat.
- SAST and secret scanning guardrails to AI prompts.
- Self-healing metrics and rollback mechanisms in `verify --auto-fix`.

## [2.3.1] - 2026-09-02
### Changed
- Promoted self-healing engine from beta to stable.
- Minor performance patches.

## [2.2.0] - 2026-08-15
### Added
- Web Studio UI (\`ghk web\`) for visual orchestrating.
- AST Step Definitions Indexer for hallucination prevention via `ts-morph`.
- DOM & Data Model Anchor for precise test generation.
- \`ghk skill\` command for IDE (.cursorrules) integration.
- Headless CI/CD Mode.
- Official `@cucumber/gherkin` parser support.
- Initial multi-stack templates (Rust, Go, Mobile, React, Java).

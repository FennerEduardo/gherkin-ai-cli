import { describe, it, expect } from 'vitest';
import { featureToSpecKit, parseAcceptanceScenario, parseSpecKitSpec, specKitToFeature } from '../../src/core/interop/speckit';
import { parseGherkinText } from '../../src/core/gherkin-parser';

const SPEC = `# Feature Specification: Photo Albums

**Feature Branch**: \`001-photo-albums\`
**Created**: 2026-09-01
**Status**: Draft
**Input**: User description: "Organize photos in albums grouped by date"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create an album (Priority: P1)

A user groups photos into a new album.

**Why this priority**: Core value.

**Independent Test**: Create an album and see it listed.

**Acceptance Scenarios**:

1. **Given** a user with 3 photos, **When** the user creates an album "Trip", **Then** the album "Trip" is listed **And** it contains 0 photos
2. **Given** an album "Trip" exists, **When** the user creates an album "Trip", **Then** a duplicate name error is shown

---

### User Story 2 - Reorder albums (Priority: P2)

**Acceptance Scenarios**:

1. **Given** two albums, **When** the user drags the second above the first, **Then** the order is saved

### Edge Cases

- What happens when an album has 10 000 photos?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow creating albums
- **FR-002**: System MUST reject duplicate album names [NEEDS CLARIFICATION: case sensitive?]

## Success Criteria *(mandatory)*

- **SC-001**: Users create an album in under 10 seconds
`;

describe('Spec Kit interop', () => {
  it('parses acceptance scenarios with And clauses', () => {
    expect(parseAcceptanceScenario('1. **Given** a, **When** b, **Then** c **And** d')).toEqual({ given: ['a'], when: ['b'], then: ['c', 'd'] });
    expect(parseAcceptanceScenario('plain text')).toBeUndefined();
  });

  it('parses a spec.md', () => {
    const spec = parseSpecKitSpec(SPEC);
    expect(spec.title).toBe('Photo Albums');
    expect(spec.branch).toBe('001-photo-albums');
    expect(spec.input).toBe('Organize photos in albums grouped by date');
    expect(spec.stories.map(s => [s.index, s.title, s.priority, s.scenarios.length])).toEqual([[1, 'Create an album', 'P1', 2], [2, 'Reorder albums', 'P2', 1]]);
    expect(spec.requirements.map(r => r.id)).toEqual(['FR-001', 'FR-002']);
    expect(spec.successCriteria[0].id).toBe('SC-001');
    expect(spec.edgeCases).toEqual(['What happens when an album has 10 000 photos?']);
    expect(spec.clarifications).toEqual(['case sensitive?']);
  });

  it('imports into a valid, tagged .feature file', () => {
    const feature = specKitToFeature(parseSpecKitSpec(SPEC));
    const parsed = parseGherkinText(feature);
    expect(parsed.featureName).toBe('Photo Albums');
    expect(parsed.scenarios).toHaveLength(3);
    expect(parsed.scenarios[0].steps.map(s => s.keyword)).toEqual(['Given', 'When', 'Then', 'And']);
    expect(parsed.scenarios[0].tags.map(t => t.replace(/^@/, ''))).toEqual(['US1', 'P1']);
    expect(feature).toContain('FR-002: System MUST reject duplicate album names');
  });

  it('round-trips user stories, priorities and requirements', () => {
    const exported = featureToSpecKit(parseGherkinText(specKitToFeature(parseSpecKitSpec(SPEC))), { branch: '001-photo-albums', date: '2026-10-05' });
    const again = parseSpecKitSpec(exported);
    expect(again.title).toBe('Photo Albums');
    expect(again.stories.map(s => [s.title, s.priority, s.scenarios.length])).toEqual([['Create an album', 'P1', 2], ['Reorder albums', 'P2', 1]]);
    expect(again.stories[0].scenarios[0]).toEqual({ given: ['a user with 3 photos'], when: ['the user creates an album "Trip"'], then: ['the album "Trip" is listed', 'it contains 0 photos'] });
    expect(again.requirements.map(r => r.id)).toEqual(['FR-001', 'FR-002']);
  });

  it('exports plain features with one user story per scenario and derived requirements', () => {
    const md = featureToSpecKit(parseGherkinText(`Feature: Checkout
  Scenario: Pay by card
    Given a cart
    When the customer pays by card
    Then the order is confirmed
`), { date: '2026-10-05' });
    expect(md).toContain('### User Story 1 - Pay by card (Priority: P1)');
    expect(md).toContain('1. **Given** a cart, **When** the customer pays by card, **Then** the order is confirmed');
    expect(md).toContain('- **FR-001**: System MUST support: Pay by card');
  });
});

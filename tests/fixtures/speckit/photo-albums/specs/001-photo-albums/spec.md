# Feature Specification: Photo albums

**Feature Branch**: `001-photo-albums`
**Created**: 2026-10-20
**Status**: Draft
**Input**: User description: "Let users group their photos into albums and share an album by link"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create an album (Priority: P1)

A signed-in user groups photos into a named album.

**Why this priority**: Albums are the core of the product.

**Independent Test**: Create an album with two photos and list it.

**Acceptance Scenarios**:

1. **Given** a signed-in user with 2 photos, **When** the user creates the album "Holidays" with both photos, **Then** the album "Holidays" lists 2 photos
2. **Given** a signed-in user, **When** the user creates an album without a name, **Then** the album is rejected because the name is required

---

### User Story 2 - Share an album by link (Priority: P2)

The owner shares an album with people who have no account.

**Acceptance Scenarios**:

1. **Given** an album owned by the user, **When** the owner creates a share link, **Then** anyone with the link can view the album

---

### Edge Cases

- What happens when a shared album is deleted?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST let a signed-in user create an album with a name and photos
- **FR-002**: System MUST reject an album without a name
- **FR-003**: System MUST let the owner share an album through a link

## Success Criteria *(mandatory)*

- **SC-001**: Users create an album in under 30 seconds

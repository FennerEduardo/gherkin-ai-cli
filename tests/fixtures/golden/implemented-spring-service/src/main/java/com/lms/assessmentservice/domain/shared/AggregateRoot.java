package com.lms.assessmentservice.domain.shared;

import java.util.ArrayList;
import java.util.List;

/** Collects the events an aggregate records until the application service publishes them. */
public abstract class AggregateRoot {
    private final List<DomainEvent> pendingEvents = new ArrayList<>();
    protected long version;

    protected void record(DomainEvent event) {
        pendingEvents.add(event);
    }

    /** Returns the recorded events and clears them, so they are published exactly once. */
    public List<DomainEvent> pullEvents() {
        List<DomainEvent> events = List.copyOf(pendingEvents);
        pendingEvents.clear();
        return events;
    }

    /** Optimistic-locking version as loaded from storage (0 = not persisted yet). */
    public long version() { return version; }

    /** Called by repositories after a successful save. */
    public void persistedAs(long newVersion) { this.version = newVersion; }
}

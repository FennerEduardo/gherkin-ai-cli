package com.lms.assessmentservice.runtime;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

class GradeAggregateTest {

    @Test
    void startsInTheInitialStateWithNoEvents() {
        var aggregate = new GradeAggregate("agg-1");
        assertEquals(GradeState.PENDING, aggregate.getState());
        assertEquals(0, aggregate.getVersion());
        assertTrue(aggregate.getPendingEvents().isEmpty());
    }

    @Test
    void rejectsAnAggregateWithoutId() {
        assertThrows(DomainValidationException.class, () -> new GradeAggregate(""));
    }

    @Test
    void publishGradeRecordsSubmissionGradedAndBumpsTheVersion() {
        var aggregate = new GradeAggregate("agg-1");
        var event = aggregate.publishGrade(new GradeCommand("agg-1"));
        assertEquals(GradeEventType.SubmissionGraded, event.type());
        assertEquals(1, event.version());
        assertEquals(1, aggregate.getVersion());
        assertEquals(1, aggregate.getPendingEvents().size());
    }

    @Test
    void publishGradeRejectsACommandWithoutId() {
        var aggregate = new GradeAggregate("agg-1");
        assertThrows(DomainValidationException.class, () -> aggregate.publishGrade(new GradeCommand("")));
        assertTrue(aggregate.getPendingEvents().isEmpty());
    }
}

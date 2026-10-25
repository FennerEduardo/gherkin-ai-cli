package com.lms.assessmentservice.infrastructure.web;

import java.time.Instant;

/** Standard error contract shared by every LMS service (definitions §65). */
public record ApiError(Instant timestamp, int status, String code, String message, String correlationId) {
    public static ApiError of(int status, String code, String message) {
        return new ApiError(Instant.now(), status, code, message, RequestContext.correlationId());
    }
}

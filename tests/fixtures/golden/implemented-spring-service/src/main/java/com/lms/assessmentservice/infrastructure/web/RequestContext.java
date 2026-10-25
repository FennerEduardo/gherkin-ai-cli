package com.lms.assessmentservice.infrastructure.web;

import org.slf4j.MDC;

/**
 * Correlation data of the current request or message, kept in the logging MDC so every log line,
 * audit entry and outbox event carries it (definitions §22, §44).
 */
public final class RequestContext {
    public static final String CORRELATION_ID = "correlationId";
    public static final String CAUSATION_ID = "causationId";

    private RequestContext() {}

    public static String correlationId() { return MDC.get(CORRELATION_ID); }
    public static String causationId() { return MDC.get(CAUSATION_ID); }

    public static void set(String correlationId, String causationId) {
        if (correlationId != null) MDC.put(CORRELATION_ID, correlationId); else MDC.remove(CORRELATION_ID);
        if (causationId != null) MDC.put(CAUSATION_ID, causationId); else MDC.remove(CAUSATION_ID);
    }

    public static void clear() {
        MDC.remove(CORRELATION_ID);
        MDC.remove(CAUSATION_ID);
    }
}

package com.lms.assessmentservice.domain.shared;

/**
 * A business rule was violated. The code is part of the public error contract
 * (definitions §65); the kind tells adapters how to classify it without the domain
 * knowing about HTTP.
 */
public class DomainException extends RuntimeException {
    public enum Kind { INVALID, NOT_FOUND, CONFLICT, UNAUTHENTICATED, FORBIDDEN }

    private final String code;
    private final Kind kind;

    public DomainException(Kind kind, String code, String message) {
        super(message);
        this.kind = kind;
        this.code = code;
    }

    public static DomainException invalid(String code, String message) { return new DomainException(Kind.INVALID, code, message); }
    public static DomainException notFound(String code, String message) { return new DomainException(Kind.NOT_FOUND, code, message); }
    public static DomainException conflict(String code, String message) { return new DomainException(Kind.CONFLICT, code, message); }
    public static DomainException unauthenticated(String code, String message) { return new DomainException(Kind.UNAUTHENTICATED, code, message); }
    public static DomainException forbidden(String code, String message) { return new DomainException(Kind.FORBIDDEN, code, message); }

    public String code() { return code; }
    public Kind kind() { return kind; }
}

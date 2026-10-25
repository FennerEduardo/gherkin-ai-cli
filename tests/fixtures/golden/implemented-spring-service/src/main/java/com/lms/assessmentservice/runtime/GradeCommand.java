package com.lms.assessmentservice.runtime;

import java.util.Map;

public record GradeCommand(String id, Map<String, Object> payload) {
    public GradeCommand(String id) {
        this(id, Map.of());
    }
}

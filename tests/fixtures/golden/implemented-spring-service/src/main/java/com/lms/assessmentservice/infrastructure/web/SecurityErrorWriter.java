package com.lms.assessmentservice.infrastructure.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.MediaType;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;

/** 401 and 403 from Spring Security in the standard error contract. */
public final class SecurityErrorWriter {
    private SecurityErrorWriter() {}

    public static AuthenticationEntryPoint unauthenticated(ObjectMapper json) {
        return (request, response, e) -> write(json, response, 401, "UNAUTHENTICATED", "A valid bearer token is required");
    }

    public static AccessDeniedHandler forbidden(ObjectMapper json) {
        return (request, response, e) -> write(json, response, 403, "ACCESS_DENIED", "Not allowed");
    }

    private static void write(ObjectMapper json, HttpServletResponse response, int status, String code, String message) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        json.writeValue(response.getOutputStream(), ApiError.of(status, code, message));
    }
}

package com.lms.assessmentservice.api;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.lms.assessmentservice.application.GradingService;
import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.domain.shared.DomainException;
import com.lms.assessmentservice.infrastructure.security.ResourceServerSecurityConfig;
import com.lms.assessmentservice.infrastructure.web.ApiExceptionHandler;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(controllers = GradeController.class)
@Import({ResourceServerSecurityConfig.class, ApiExceptionHandler.class})
@TestPropertySource(properties = "lms.security.jwt-secret=test-secret-with-at-least-32-bytes-1234567890")
class GradeApiTest {
    @Autowired MockMvc mvc;
    @MockitoBean GradingService grading;

    private static GradingService.GradeView view(Grade.Status status) {
        return new GradingService.GradeView("g-1", "sub-1", "asg-1", "Limits", "c-1", "s-1", new BigDecimal("87.50"), 0, 100, "ok", status,
            Instant.EPOCH, status == Grade.Status.PUBLISHED ? Instant.EPOCH : null);
    }

    @Test
    void gradesWithDecimalScoresAndPublishes() throws Exception {
        given(grading.grade(any(), eq("t-1"), eq("sub-1"), eq(new BigDecimal("87.5")), eq("ok"))).willReturn(view(Grade.Status.DRAFT));
        mvc.perform(put("/api/v1/institutions/t-1/submissions/sub-1/grade").with(jwt()).contentType(MediaType.APPLICATION_JSON)
                .content("{\"score\":87.5,\"feedback\":\"ok\"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("DRAFT")).andExpect(jsonPath("$.score").value(87.5));
        given(grading.publish(any(), eq("t-1"), eq("sub-1"))).willReturn(view(Grade.Status.PUBLISHED));
        mvc.perform(post("/api/v1/institutions/t-1/submissions/sub-1/grade/publication").with(jwt()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("PUBLISHED"));
    }

    @Test
    void validationAndErrors() throws Exception {
        mvc.perform(put("/api/v1/institutions/t-1/submissions/sub-1/grade").with(jwt()).contentType(MediaType.APPLICATION_JSON).content("{\"score\":1.234}"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        mvc.perform(post("/api/v1/institutions/t-1/submissions/sub-1/grade/corrections").with(jwt()).contentType(MediaType.APPLICATION_JSON)
                .content("{\"score\":90}"))
            .andExpect(status().isBadRequest());
        given(grading.grade(any(), eq("t-1"), eq("sub-1"), any(), any())).willThrow(DomainException.invalid("SCORE_OUT_OF_RANGE", "range"));
        mvc.perform(put("/api/v1/institutions/t-1/submissions/sub-1/grade").with(jwt()).contentType(MediaType.APPLICATION_JSON).content("{\"score\":120}"))
            .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("SCORE_OUT_OF_RANGE"));
        mvc.perform(get("/api/v1/institutions/t-1/students/s-1/grades")).andExpect(status().isUnauthorized());
    }

    @Test
    void studentGrades() throws Exception {
        given(grading.publishedGradesOfStudent(any(), eq("t-1"), eq("s-1"))).willReturn(List.of(view(Grade.Status.PUBLISHED)));
        mvc.perform(get("/api/v1/institutions/t-1/students/s-1/grades").with(jwt()))
            .andExpect(status().isOk()).andExpect(jsonPath("$[0].assignmentTitle").value("Limits"));
    }
}

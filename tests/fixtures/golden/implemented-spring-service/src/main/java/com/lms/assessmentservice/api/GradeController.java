package com.lms.assessmentservice.api;

import com.lms.assessmentservice.application.GradingService;
import com.lms.assessmentservice.application.GradingService.GradeView;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.List;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Grading (definitions §36: GET /students/{id}/grades), scoped by institution. */
@RestController
@RequestMapping("/api/v1/institutions/{institutionId}")
public class GradeController {
    public record GradeRequest(@NotNull @Digits(integer = 5, fraction = 2) BigDecimal score, @Size(max = 5000) String feedback) {}

    public record CorrectionRequest(@NotNull @Digits(integer = 5, fraction = 2) BigDecimal score, @NotBlank @Size(max = 500) String reason) {}

    private final GradingService grading;

    public GradeController(GradingService grading) {
        this.grading = grading;
    }

    /** Creates or updates the draft grade of a submission. */
    @PutMapping("/submissions/{submissionId}/grade")
    public GradeView grade(@AuthenticationPrincipal Jwt principal, @PathVariable String institutionId, @PathVariable String submissionId,
                           @Valid @RequestBody GradeRequest request) {
        return grading.grade(Actors.from(principal), institutionId, submissionId, request.score(), request.feedback());
    }

    @PostMapping("/submissions/{submissionId}/grade/publication")
    public GradeView publish(@AuthenticationPrincipal Jwt principal, @PathVariable String institutionId, @PathVariable String submissionId) {
        return grading.publish(Actors.from(principal), institutionId, submissionId);
    }

    @PostMapping("/submissions/{submissionId}/grade/corrections")
    public GradeView correct(@AuthenticationPrincipal Jwt principal, @PathVariable String institutionId, @PathVariable String submissionId,
                             @Valid @RequestBody CorrectionRequest request) {
        return grading.correct(Actors.from(principal), institutionId, submissionId, request.score(), request.reason());
    }

    @GetMapping("/assignments/{assignmentId}/grades")
    public List<GradeView> assignmentGrades(@AuthenticationPrincipal Jwt principal, @PathVariable String institutionId, @PathVariable String assignmentId) {
        return grading.gradesOfAssignment(Actors.from(principal), institutionId, assignmentId);
    }

    @GetMapping("/students/{studentId}/grades")
    public List<GradeView> studentGrades(@AuthenticationPrincipal Jwt principal, @PathVariable String institutionId, @PathVariable String studentId) {
        return grading.publishedGradesOfStudent(Actors.from(principal), institutionId, studentId);
    }
}

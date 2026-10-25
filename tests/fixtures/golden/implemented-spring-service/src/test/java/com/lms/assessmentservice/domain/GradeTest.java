package com.lms.assessmentservice.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.domain.grade.GradingScale;
import com.lms.assessmentservice.domain.shared.DomainEvent;
import java.math.BigDecimal;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class GradeTest {
    private static final Instant NOW = Instant.parse("2027-02-25T10:00:00Z");
    private static final Grade.Work WORK = new Grade.Work("sub-1", "asg-1", "Limits worksheet", "c-1", "s-1");

    @Test
    void scalesValidateRangeAndPrecision() {
        var oneToFive = new GradingScale(1, 5);
        assertThat(oneToFive.validate(new BigDecimal("4.5"))).isEqualByComparingTo("4.50");
        assertThatThrownBy(() -> oneToFive.validate(new BigDecimal("0.99"))).hasFieldOrPropertyWithValue("code", "SCORE_OUT_OF_RANGE");
        assertThatThrownBy(() -> oneToFive.validate(new BigDecimal("5.01"))).hasFieldOrPropertyWithValue("code", "SCORE_OUT_OF_RANGE");
        assertThatThrownBy(() -> oneToFive.validate(new BigDecimal("4.555"))).hasFieldOrPropertyWithValue("code", "SCORE_PRECISION");
        assertThatThrownBy(() -> oneToFive.validate(null)).hasFieldOrPropertyWithValue("code", "SCORE_REQUIRED");
        assertThatThrownBy(() -> new GradingScale(5, 5)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void draftsAreRegradedPublishedOnceThenOnlyCorrected() {
        var grade = Grade.draft("g-1", "t-1", WORK, BigDecimal.valueOf(70), GradingScale.DEFAULT, "ok", "teacher-7", NOW);
        grade.regrade(BigDecimal.valueOf(75), GradingScale.DEFAULT, "better", "teacher-7", NOW);
        grade.publish("teacher-7", NOW);
        assertThatThrownBy(() -> grade.publish("teacher-7", NOW)).hasFieldOrPropertyWithValue("code", "GRADE_ALREADY_PUBLISHED");
        assertThatThrownBy(() -> grade.regrade(BigDecimal.ONE, GradingScale.DEFAULT, null, "teacher-7", NOW))
            .hasFieldOrPropertyWithValue("code", "GRADE_ALREADY_PUBLISHED");
        assertThatThrownBy(() -> grade.correct(BigDecimal.valueOf(80), " ", "teacher-7", NOW)).hasFieldOrPropertyWithValue("code", "CORRECTION_REASON_REQUIRED");
        grade.correct(BigDecimal.valueOf(80), "Exercise 3 was graded twice", "teacher-7", NOW);
        assertThat(grade.score()).isEqualByComparingTo("80");
        var events = grade.pullEvents();
        assertThat(events).extracting(DomainEvent::type).containsExactly("SubmissionGraded", "SubmissionGraded", "GradePublished", "GradeChanged");
        assertThat(events.get(3).payload()).containsEntry("previousScore", "75.00").containsEntry("score", "80.00");
        assertThat(events.get(2).payload()).containsEntry("studentId", "s-1").containsEntry("scaleMax", 100);
    }

    @Test
    void draftsCannotBeCorrected() {
        var grade = Grade.draft("g-1", "t-1", WORK, BigDecimal.TEN, GradingScale.DEFAULT, null, "teacher-7", NOW);
        assertThatThrownBy(() -> grade.correct(BigDecimal.ONE, "reason", "teacher-7", NOW)).hasFieldOrPropertyWithValue("code", "GRADE_NOT_PUBLISHED");
    }
}

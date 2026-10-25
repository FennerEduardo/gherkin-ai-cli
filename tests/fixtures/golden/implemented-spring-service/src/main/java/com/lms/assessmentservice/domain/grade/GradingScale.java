package com.lms.assessmentservice.domain.grade;

import com.lms.assessmentservice.domain.shared.DomainException;
import java.math.BigDecimal;
import java.math.RoundingMode;

/** The institution's grading range (institution service InstitutionConfigured; 0-100 until configured). */
public record GradingScale(int min, int max) {
    public static final GradingScale DEFAULT = new GradingScale(0, 100);

    public GradingScale {
        if (min < 0 || max <= min) throw new IllegalArgumentException("Invalid grading scale " + min + "-" + max);
    }

    /** Scores have at most two decimals and must lie within the scale. */
    public BigDecimal validate(BigDecimal score) {
        if (score == null) throw DomainException.invalid("SCORE_REQUIRED", "A score is required");
        if (score.scale() > 2) throw DomainException.invalid("SCORE_PRECISION", "Scores have at most two decimals");
        if (score.compareTo(BigDecimal.valueOf(min)) < 0 || score.compareTo(BigDecimal.valueOf(max)) > 0) {
            throw DomainException.invalid("SCORE_OUT_OF_RANGE", "The score must be between " + min + " and " + max);
        }
        return score.setScale(2, RoundingMode.UNNECESSARY);
    }

    @Override
    public String toString() { return min + "-" + max; }
}

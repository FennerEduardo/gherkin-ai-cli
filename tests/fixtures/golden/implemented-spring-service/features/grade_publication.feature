@context:assessment @aggregate:Grade
Feature: Grading and grade publication
  As a teacher
  I want to grade submissions and publish the grades
  So that students and authorized guardians can see their results

  Background:
    Given an active institution "inst-001"
    And the teacher "teacher-7" is responsible for the course "MATH-101"
    And the submission "sub-1" of "student-123" has status "SUBMITTED"

  Scenario: Teacher grades a submission
    When the teacher grades "sub-1" with score 87 out of 100 and feedback
    Then the grade should be recorded with status "DRAFT"
    And the "SubmissionGraded" event is published

  Scenario: Teacher publishes the grade
    Given the grade of "sub-1" has status "DRAFT"
    When the teacher publishes the grade of "sub-1"
    Then the grade status should become "PUBLISHED"
    And the change should be recorded in the audit log
    And the "GradePublished" event is published

  Scenario: Score outside the institution grading scale is rejected
    When the teacher grades "sub-1" with score 120 out of 100
    Then the request should fail with error "SCORE_OUT_OF_RANGE"

  Scenario: Score validation uses the grading scale configured by the institution
    Given the institution configured the grading scale "0-20"
    When the teacher grades "sub-1" with score 87 out of 20
    Then the request should be refused with reason "SCORE_OUT_OF_RANGE"
    And no "SubmissionGraded" event is published

  Scenario: A published grade is corrected only with a reason
    Given the grade of "sub-1" has status "PUBLISHED"
    When the teacher corrects the grade of "sub-1" to 90 because "Exercise 3 was graded twice"
    Then the change should be recorded in the audit log
    And the "GradeChanged" event is published

  Scenario: The student sees only published grades
    Given the grade of "sub-1" has status "DRAFT"
    When "student-123" requests their grades
    Then no grade should be returned
    When the teacher publishes the grade of "sub-1"
    And "student-123" requests their grades
    Then the published grade should be returned

  Scenario: Another teacher cannot grade the course
    Given the caller is the teacher "teacher-8"
    When the teacher grades "sub-1" with score 50 out of 100
    Then the request should be denied with HTTP 403 and error "COURSE_NOT_ASSIGNED"

-- Generated Seed SQL Fixtures for PostgreSQL / MySQL
-- Feature: Grading and grade publication

INSERT INTO grading_and_grade_publication (id, grades, status, become, error)
VALUES (
  'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'test', 'test', 'test', 'test'
) ON CONFLICT (id) DO NOTHING;

# ADR 001: Architecture Decisions for Grading and grade publication

## Status
Accepted

## Context
Project requiring structured implementation matching Gherkin specification.

## Decisions
- **Architecture Style**: Microservices Architecture (microservices)
- **Primary Backend Language**: java
- **Backend Framework**: spring-boot (Java 17/21/25 (Spring Boot 3.2+))
- **ORM / Persistence**: hibernate (org.hibernate.orm:hibernate-core:6.4.4.Final)
- **Validation**: jakarta-validation (jakarta.validation:jakarta.validation-api:3.0.2)
- **Authentication**: jwt-bcrypt (bcrypt cost factor 12, JWT TTL 3600s)
- **Backend Testing Framework**: junit (org.junit.jupiter:junit-jupiter:5.10.2)

## Prohibited Layer Dependencies
Domain core must NOT import:
- `org.springframework.*`
- `java.sql.Statement without PreparedStatement`

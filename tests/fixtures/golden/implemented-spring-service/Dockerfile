# syntax=docker/dockerfile:1.7
# Multi-stage image for every LMS Spring Boot service (copied as <service>/Dockerfile).
# Build: compiled inside the image with a cached Maven repository. Run: JRE only, non-root user.

FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B -q dependency:go-offline -DexcludeArtifactIds=jacoco-maven-plugin || true
COPY src src
# features/ is a test resource of the build (the Gherkin specification).
COPY features features
RUN --mount=type=cache,target=/root/.m2 mvn -B -q -DskipTests -Djacoco.skip=true package

FROM eclipse-temurin:17-jre-alpine
RUN addgroup -S lms && adduser -S lms -G lms
WORKDIR /app
COPY --from=build /src/target/*.jar app.jar
USER lms
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=10 \
  CMD wget -qO- "http://localhost:${SERVER_PORT:-8080}/actuator/health/readiness" >/dev/null || exit 1
ENTRYPOINT ["java", "-jar", "/app/app.jar"]

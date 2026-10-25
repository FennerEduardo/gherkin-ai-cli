package com.lms.assessmentservice;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.Architectures.layeredArchitecture;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

/** Hexagonal layering (.gherkin-ai/constitution.yaml): enforced here because ghk checks layers as src/<layer> folders. */
@AnalyzeClasses(packages = "com.lms.assessmentservice", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule layers = layeredArchitecture().consideringOnlyDependenciesInLayers()
        .layer("Domain").definedBy("..domain..")
        .layer("Application").definedBy("..application..")
        .layer("Api").definedBy("..api..")
        .layer("Infrastructure").definedBy("..infrastructure..")
        .whereLayer("Api").mayNotBeAccessedByAnyLayer()
        .whereLayer("Application").mayOnlyBeAccessedByLayers("Api", "Infrastructure")
        .whereLayer("Domain").mayOnlyBeAccessedByLayers("Application", "Api", "Infrastructure");

    @ArchTest
    static final ArchRule domainIsFrameworkFree = noClasses().that().resideInAPackage("..domain..")
        .should().dependOnClassesThat().resideInAnyPackage("org.springframework..", "jakarta..", "java.sql..", "com.rabbitmq..");

    @ArchTest
    static final ArchRule applicationUsesOnlyTransactionsFromSpring = noClasses().that().resideInAPackage("..application..")
        .should().dependOnClassesThat().resideInAnyPackage("org.springframework.web..", "org.springframework.jdbc..", "jakarta.servlet..",
            "com.rabbitmq..", "java.sql..");
}

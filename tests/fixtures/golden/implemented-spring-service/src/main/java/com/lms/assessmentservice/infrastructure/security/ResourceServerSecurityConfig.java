package com.lms.assessmentservice.infrastructure.security;

import com.lms.assessmentservice.infrastructure.web.SecurityErrorWriter;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Stateless resource server: every API call needs a JWT issued by the identity service
 * (definitions §66). Only validation lives here; issuing tokens is the identity service's job.
 */
@Configuration
public class ResourceServerSecurityConfig {

    @Bean
    SecurityFilterChain api(HttpSecurity http, ObjectMapper json) throws Exception {
        return http
            .csrf(csrf -> csrf.disable()) // bearer tokens only, no cookies
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/health/**", "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                .anyRequest().authenticated())
            .oauth2ResourceServer(rs -> rs
                .jwt(jwt -> {})
                .authenticationEntryPoint(SecurityErrorWriter.unauthenticated(json))
                .accessDeniedHandler(SecurityErrorWriter.forbidden(json)))
            .exceptionHandling(e -> e
                .authenticationEntryPoint(SecurityErrorWriter.unauthenticated(json))
                .accessDeniedHandler(SecurityErrorWriter.forbidden(json)))
            .build();
    }

    @Bean
    JwtDecoder jwtDecoder(@Value("${lms.security.jwt-secret}") String secret, @Value("${lms.security.jwt-issuer:lms-identity}") String issuer) {
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException("lms.security.jwt-secret (JWT_SECRET) must have at least 32 bytes");
        }
        var key = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(JwtValidators.createDefault(), new JwtIssuerValidator(issuer)));
        return decoder;
    }
}

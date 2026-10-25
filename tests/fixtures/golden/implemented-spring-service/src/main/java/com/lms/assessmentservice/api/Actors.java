package com.lms.assessmentservice.api;

import com.lms.assessmentservice.application.Actor;
import java.util.HashSet;
import java.util.List;
import org.springframework.security.oauth2.jwt.Jwt;

/** Builds the application's Actor from the identity service's validated JWT claims. */
final class Actors {
    private Actors() {}

    static Actor from(Jwt jwt) {
        if (jwt == null) return null;
        return new Actor(jwt.getSubject(), jwt.getClaimAsString("tenant"), new HashSet<>(list(jwt, "roles")), new HashSet<>(list(jwt, "permissions")));
    }

    private static List<String> list(Jwt jwt, String claim) {
        List<String> values = jwt.getClaimAsStringList(claim);
        return values == null ? List.of() : values;
    }
}

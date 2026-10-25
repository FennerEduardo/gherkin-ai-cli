package com.lms.assessmentservice.application;

import com.lms.assessmentservice.domain.shared.DomainException;
import java.util.Set;

/**
 * The authenticated caller, from the identity service's signed JWT: user, tenant (institution),
 * roles and permissions. Authorization combines them with the institution of the request
 * (definitions §29: user + role + institution + resource).
 */
public record Actor(String userId, String tenant, Set<String> roles, Set<String> permissions) {
    public static final String PLATFORM_ADMIN = "PLATFORM_ADMIN";

    public Actor {
        roles = roles == null ? Set.of() : Set.copyOf(roles);
        permissions = permissions == null ? Set.of() : Set.copyOf(permissions);
    }

    public boolean isPlatformAdmin() { return roles.contains(PLATFORM_ADMIN); }

    /** The token was issued for this institution and grants the permission there. */
    public boolean can(String institutionId, String permission) {
        return institutionId != null && institutionId.equals(tenant) && permissions.contains(permission);
    }

    public static Actor require(Actor actor) {
        if (actor == null || actor.userId() == null) throw DomainException.unauthenticated("UNAUTHENTICATED", "Authentication is required");
        return actor;
    }
}

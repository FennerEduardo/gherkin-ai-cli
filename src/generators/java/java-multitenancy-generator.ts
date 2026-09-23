// --------------------------------------------------------------------------
// Multi-tenancy Pattern for Java 21 / Spring Boot 3 / Hibernate 6
// --------------------------------------------------------------------------

export function generateJavaMultiTenancyInfrastructure(packageName: string): { filename: string; content: string }[] {
  const packageHeader = `package ${packageName}.infrastructure.multitenancy;\n\n`;

  const tenantContext = `${packageHeader}public class TenantContext {
    private static final ThreadLocal<String> currentTenant = new InheritableThreadLocal<>();

    public static String getCurrentTenant() {
        return currentTenant.get();
    }

    public static void setCurrentTenant(String tenantId) {
        currentTenant.set(tenantId);
    }

    public static void clear() {
        currentTenant.remove();
    }
}
`;

  const tenantFilter = `${packageHeader}import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Component
public class TenantFilter extends OncePerRequestFilter {

    private static final String TENANT_HEADER = "X-Tenant-Id";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {

        String tenantId = request.getHeader(TENANT_HEADER);
        
        if (tenantId != null && !tenantId.isBlank()) {
            TenantContext.setCurrentTenant(tenantId);
        } else {
            // Default tenant or throw exception based on strictness
            TenantContext.setCurrentTenant("default");
        }

        try {
            filterChain.doFilter(request, response);
        } finally {
            TenantContext.clear();
        }
    }
}
`;

  const tenantIdentifierResolver = `${packageHeader}import org.hibernate.context.spi.CurrentTenantIdentifierResolver;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class CustomTenantIdentifierResolver implements CurrentTenantIdentifierResolver<String> {

    @Override
    public String resolveCurrentTenantIdentifier() {
        String tenantId = TenantContext.getCurrentTenant();
        return tenantId != null ? tenantId : "default";
    }

    @Override
    public boolean validateExistingCurrentSessions() {
        return true;
    }
}
`;

  return [
    { filename: 'infrastructure/multitenancy/TenantContext.java', content: tenantContext },
    { filename: 'infrastructure/multitenancy/TenantFilter.java', content: tenantFilter },
    { filename: 'infrastructure/multitenancy/CustomTenantIdentifierResolver.java', content: tenantIdentifierResolver }
  ];
}

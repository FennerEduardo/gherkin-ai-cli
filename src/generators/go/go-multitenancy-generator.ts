// --------------------------------------------------------------------------
// Multi-tenancy Pattern for Go (net/http + pgx)
// Uses context.Context for passing Tenant ID down to the repository layer
// --------------------------------------------------------------------------

export function generateGoMultiTenancyInfrastructure(packageName: string): { filename: string; content: string }[] {
  const middlewareCode = `package ${packageName}

import (
	"context"
	"net/http"
)

type contextKey string

const TenantIDKey contextKey = "tenant_id"

// TenantMiddleware extracts the X-Tenant-Id header and injects it into the request context.
func TenantMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenantID := r.Header.Get("X-Tenant-Id")
		
		if tenantID == "" {
			tenantID = "default"
		}

		ctx := context.WithValue(r.Context(), TenantIDKey, tenantID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetTenantID retrieves the current tenant ID from the context.
func GetTenantID(ctx context.Context) string {
	if val, ok := ctx.Value(TenantIDKey).(string); ok {
		return val
	}
	return "default"
}
`;

  const repoTemplateCode = `package ${packageName}

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ExampleTenantAwareRepository shows how to use the context tenant ID
// in your data access layer to isolate data globally.
type ExampleTenantAwareRepository struct {
	pool *pgxpool.Pool
}

func NewExampleTenantAwareRepository(pool *pgxpool.Pool) *ExampleTenantAwareRepository {
	return &ExampleTenantAwareRepository{pool: pool}
}

func (r *ExampleTenantAwareRepository) FindAll(ctx context.Context) ([]string, error) {
	tenantID := GetTenantID(ctx)

	// Inject tenantID into every query to enforce isolation
	query := \`
		SELECT data_column
		FROM some_tenant_aware_table
		WHERE tenant_id = $1
	\`

	rows, err := r.pool.Query(ctx, query, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []string
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		results = append(results, data)
	}

	return results, nil
}
`;

  return [
    { filename: 'infrastructure/multitenancy/middleware.go', content: middlewareCode },
    { filename: 'infrastructure/multitenancy/repository_template.go', content: repoTemplateCode }
  ];
}

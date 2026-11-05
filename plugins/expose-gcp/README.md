# @gherkin-ai/expose-gcp (experimental)

Gateway provider `gcp-apigateway` for `ghk expose` (gherkin-ai 3.3, plugin API 2). It puts **Google Cloud API Gateway** in front of the MCP runtime that `ghk expose generate` writes, with the runtime on Cloud Run.

- **What the gateway enforces:** the caller's JWT (`x-google-issuer`, `x-google-jwks_uri`, `x-google-audiences`) on the single `POST /mcp` route.
- **The OpenAPI document:** it is annotated with the approved tools (`x-ghk-tools`), for review.
- **What stays in the runtime:** rate limits, per-tool authorization, tenants, approvals and backend credentials. The runtime authorizes every call again.
- **Not configured:** private networking and tool search.

```bash
npm install --save-dev @gherkin-ai/expose-gcp
# gherkin-ai.config.json: "plugins": { "load": ["@gherkin-ai/expose-gcp"], "allow": ["@gherkin-ai/expose-gcp"] }
ghk expose generate --target gcp-apigateway --discovery-url https://accounts.google.com/.well-known/openid-configuration --audience orders-mcp
ghk expose plan --target gcp-apigateway
```

The provider writes `expose/gcp-apigateway/main.tf` (provider `google-beta`) with the variables `project_id`, `runtime_url` and `jwks_uri`. It is validated with `terraform validate` and never applied by gherkin-ai. The full provider is planned for gherkin-ai 3.4.

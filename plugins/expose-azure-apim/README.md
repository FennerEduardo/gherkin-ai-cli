# @gherkin-ai/expose-azure-apim (experimental)

Gateway provider `azure-apim` for `ghk expose` (gherkin-ai 3.3, plugin API 2). It puts an API of an existing **Azure API Management** instance in front of the MCP runtime that `ghk expose generate` writes. The runtime runs on Container Apps, AKS or App Service.

- **What APIM enforces:**
  - `validate-jwt`: the caller's token, against your identity provider's OIDC configuration;
  - `rate-limit-by-key`: calls per minute per token subject;
  - `traceparent`: kept.
- **What stays in the runtime:** per-tool authorization, tenants, approvals and backend credentials. The runtime authorizes every call again.
- **Not configured:** private networking and tool search.

```bash
npm install --save-dev @gherkin-ai/expose-azure-apim
# gherkin-ai.config.json: "plugins": { "load": ["@gherkin-ai/expose-azure-apim"], "allow": ["@gherkin-ai/expose-azure-apim"] }
ghk expose generate --target azure-apim --discovery-url https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration --audience api://orders-mcp
ghk expose plan --target azure-apim
```

The provider writes `expose/azure-apim/main.tf` with the variables `resource_group_name`, `api_management_name` and `runtime_url`. It is validated with `terraform validate` and never applied by gherkin-ai. The full provider is planned for gherkin-ai 3.4. Run `ghk plugin verify node_modules/@gherkin-ai/expose-azure-apim` before you load it.

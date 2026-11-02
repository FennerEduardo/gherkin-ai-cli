/* ==========================================================================
   gherkin-ai-cli - Deployment of a stateless service (stack.role "bff";
   PLAN-3.3.0 X-06b)

   A backend-for-frontend owns no data and publishes no events: its
   Terraform module, Helm chart and CI pipeline have no database, no broker
   and no outbox relay, only the URLs of the services it calls (bff.upstreams,
   as inputs per environment). The cloud modules are rendered as for any
   service with an existing Kafka cluster (no native broker resources) and
   without the database: database.tf, its network rules, variables, tfvars
   values and outputs are removed here, for both compute modes.
   ========================================================================== */

import { block, retfvars, withoutVariables } from './terraform-base';
import type { DeployConfig } from './service-spec';
import type { TerraformFile } from './terraform-aws';

const DB_VARIABLES = /^(db_[a-z_]+|create_private_service_access|postgres_[a-z_]+)$/;
const DB_TFVARS = /^(db_|create_private_service_access|postgres_)/;
const DB_OUTPUTS = ['database_endpoint', 'database_connection_name', 'database_fqdn'];

export function statelessModule(files: TerraformFile[], deploy: DeployConfig): TerraformFile[] {
  const dir = `deploy/terraform/${deploy.cloud}`;
  return files.filter(f => f.filename !== `${dir}/database.tf`).map(f => {
    if (!f.filename.startsWith(`${dir}/`)) return f;
    const rel = f.filename.slice(dir.length + 1);
    let content = f.content;
    if (rel === 'variables.tf') content = withoutVariables(content, DB_VARIABLES);
    else if (/^environments\/.+\.tfvars$/.test(rel)) content = retfvars(content, DB_TFVARS, []);
    else if (rel === 'network.tf') content = content.replace(block('resource', 'aws_security_group', 'database'), '');
    else if (rel === 'outputs.tf') for (const o of DB_OUTPUTS) content = content.replace(block('output', o), '');
    // Cloud Run / Compute Engine waited for the private services peering of the database.
    content = content.replace(/,?\s*google_service_networking_connection\.private_services/g, '');
    return { ...f, content: content.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n') };
  });
}

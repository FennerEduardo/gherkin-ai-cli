import { SpecificationIR } from '../core/semantic-ir';
import { GherkinAIConfig } from '../core/config';

export function generateC4ModelMermaid(ir: SpecificationIR, config: GherkinAIConfig): string {
  const projectName = config.projectName || 'System';
  
  // Extraemos componentes basados en bounded contexts y operaciones
  // Extract components based on bounded contexts and operations
  const contexts = new Set<string>();
  ir.scenarios.forEach(s => contexts.add(s.category));

  let mermaidCode = `C4Context
  title System Context diagram for ${projectName}

  Person(user, "User / Usuario", "A user of the system")
  System(system, "${projectName}", "The main system handling the requests")

  Rel(user, system, "Uses / Usa", "HTTPS")

C4Container
  title Container diagram for ${projectName}

  Person(user, "User / Usuario", "A user of the system")
  System_Boundary(c1, "${projectName}") {
    Container(app, "Web Application", "${config.frontendStack?.framework || 'Angular'}", "Delivers the static content and the single page application")
    Container(api, "API Application", "${config.stack.language} / ${config.stack.framework}", "Provides API endpoints via JSON/HTTPS")
    ContainerDb(db, "Database", "${config.stack.database}", "Stores application data")
    ${config.stack.messaging !== 'none' ? `Container(bus, "Message Bus", "${config.stack.messaging}", "Handles async messaging")` : ''}
  }

  Rel(user, app, "Uses / Usa", "HTTPS")
  Rel(app, api, "Makes API calls to / Realiza llamadas a la API", "JSON/HTTPS")
  Rel(api, db, "Reads from and writes to / Lee y escribe en", "${config.stack.orm || 'ORM'}")
  ${config.stack.messaging !== 'none' ? `Rel(api, bus, "Publishes events to / Publica eventos a", "AMQP/Kafka")` : ''}

C4Component
  title Component diagram for API Application

  Container_Boundary(api, "API Application") {
`;

  // Añadimos componentes dinámicos / Add dynamic components
  ir.apiEndpoints.forEach((ep, index) => {
    mermaidCode += `    Component(comp${index}, "${ep.operationId} Controller", "Controller", "Maneja ${ep.method} ${ep.path} / Handles ${ep.method} ${ep.path}")\n`;
  });

  mermaidCode += `  }
`;

  return mermaidCode;
}
